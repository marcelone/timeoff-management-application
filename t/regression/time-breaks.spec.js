'use strict';

/*
 * Time tracking — block 2: breaks and worked-time computation.
 *
 * Covers the 18 required checks: break start/stop, break without a session,
 * two simultaneous breaks, double click/concurrency, closing a session with an
 * active break, countable vs non-countable breaks, policy change not altering
 * history, active break in the provisional computation, company isolation,
 * permissions, CSRF (including multipart), client-manipulated times, DB errors
 * and rollback, DST, inherited schedules / explicit non-working days, approved
 * absences and bank holidays, migrations, and compatibility with block-1 sessions
 * that have no breaks.
 */

const assert = require('assert');
const moment = require('moment-timezone');
const H = require('./helper');
const { agent, db, postForm, registerAdmin, addEmployee, login, holidayType, bookLeave } = H;

const breaksSvc = require('../../lib/modules/time/breaks');
const compute = require('../../lib/modules/time/compute');
const clock = require('../../lib/modules/time/clock');

/** Local ISO weekday of "now" in a zone (what the /time page resolves). */
function localWeekday(zone) {
  return moment.utc().tz(zone || 'UTC').isoWeekday();
}

async function seedWeek({ companyId, scopeType, scopeId, days }) {
  await db.WorkScheduleDay.destroy({ where: { companyId, scopeType, scopeId } });
  await db.WorkScheduleDay.bulkCreate(days.map((d) => ({
    companyId,
    scopeType,
    scopeId,
    weekday: d.weekday,
    isWorkingDay: !d.off,
    startTime: d.off ? null : d.start,
    endTime: d.off ? null : d.end,
  })));
}

describe('time tracking — block 2 (breaks & computation)', function () {

  describe('schema', () => {
    it('creates break tables and keeps the block-1 tables', async () => {
      const tables = await db.sequelize.getQueryInterface().showAllTables();
      const names = tables.map((t) => (typeof t === 'string' ? t : (t.tableName || t.name)));
      ['time_breaks', 'break_policies', 'time_entries', 'time_entry_events', 'work_schedule_days']
        .forEach((t) => assert.ok(names.includes(t), 'missing table ' + t));
    });

    it('enforces one active break per session in the database', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      const empAg = agent();
      await login(empAg, emp.email, emp.password);
      await postForm(empAg, '/time/start', { modality: 'office' });

      const entry = await db.TimeEntry.findOne({ where: { userId: emp.user.id, status: 'open' } });
      await db.TimeBreak.create({
        companyId: user.companyId, userId: emp.user.id, timeEntryId: entry.id,
        type: 'regular', countsAsWork: false, startedAt: new Date(), endedAt: null,
      });
      await assert.rejects(
        () => db.TimeBreak.create({
          companyId: user.companyId, userId: emp.user.id, timeEntryId: entry.id,
          type: 'personal', countsAsWork: false, startedAt: new Date(), endedAt: null,
        }),
        /unique|constraint/i,
        'a second open break must be rejected by the database'
      );
    });
  });

  describe('break start and stop', () => {
    it('starts and finishes a break, recording both events', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      const empAg = agent();
      await login(empAg, emp.email, emp.password);
      await postForm(empAg, '/time/start', { modality: 'office' });

      let res = await postForm(empAg, '/time/break/start', { type: 'regular' });
      assert.ok([302, 303].includes(res.status));

      const brk = await db.TimeBreak.findOne({ where: { userId: emp.user.id } });
      assert.ok(brk, 'break persisted');
      assert.strictEqual(brk.type, 'regular');
      assert.strictEqual(brk.endedAt, null, 'break is active');
      assert.strictEqual(brk.countsAsWork, false, 'initial default: does not count');

      res = await postForm(empAg, '/time/break/stop', {});
      assert.ok([302, 303].includes(res.status));

      const closed = await db.TimeBreak.findByPk(brk.id);
      assert.ok(closed.endedAt, 'break closed');
      assert.ok(new Date(closed.endedAt).getTime() >= new Date(closed.startedAt).getTime());

      const events = await db.TimeEntryEvent.findAll({
        where: { timeEntryId: brk.timeEntryId }, order: [['id', 'ASC']],
      });
      assert.deepStrictEqual(events.map((e) => e.type), ['in', 'break_start', 'break_end']);
    });

    it('refuses a break without an open session', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      const empAg = agent();
      await login(empAg, emp.email, emp.password);

      const res = await postForm(empAg, '/time/break/start', { type: 'regular' });
      assert.ok([302, 303].includes(res.status), 'handled with a redirect');
      assert.strictEqual(await db.TimeBreak.count({ where: { userId: emp.user.id } }), 0,
        'no break created without a session');
    });

    it('refuses to finish a break when none is active', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      const empAg = agent();
      await login(empAg, emp.email, emp.password);
      await postForm(empAg, '/time/start', { modality: 'office' });

      const before = await db.TimeBreak.count({ where: { userId: emp.user.id } });
      const res = await postForm(empAg, '/time/break/stop', {});
      assert.ok([302, 303].includes(res.status));
      assert.strictEqual(await db.TimeBreak.count({ where: { userId: emp.user.id } }), before);
    });

    it('rejects an unknown break type', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      const empAg = agent();
      await login(empAg, emp.email, emp.password);
      await postForm(empAg, '/time/start', { modality: 'office' });

      for (const bad of ['', 'lunch', 'REGULAR', 'coffee;drop']) {
        await postForm(empAg, '/time/break/start', { type: bad });
        assert.strictEqual(await db.TimeBreak.count({ where: { userId: emp.user.id } }), 0,
          'invalid type "' + bad + '" must not create a break');
      }
    });

    it('does not allow a second break while one is active (double click)', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      const empAg = agent();
      await login(empAg, emp.email, emp.password);
      await postForm(empAg, '/time/start', { modality: 'office' });

      await postForm(empAg, '/time/break/start', { type: 'regular' });
      await postForm(empAg, '/time/break/start', { type: 'personal' });

      const active = await db.TimeBreak.findAll({ where: { userId: emp.user.id, endedAt: null } });
      assert.strictEqual(active.length, 1, 'exactly one active break');
      assert.strictEqual(active[0].type, 'regular', 'the original break is untouched');
      assert.strictEqual(await db.TimeBreak.count({ where: { userId: emp.user.id } }), 1);
    });

    it('is safe under concurrent breaks from two sessions', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      const a1 = agent();
      const a2 = agent();
      await login(a1, emp.email, emp.password);
      await login(a2, emp.email, emp.password);
      await postForm(a1, '/time/start', { modality: 'office' });

      const results = await Promise.all([
        postForm(a1, '/time/break/start', { type: 'regular' }),
        postForm(a2, '/time/break/start', { type: 'personal' }),
      ]);
      results.forEach((r) => assert.ok([302, 303].includes(r.status), 'both handled, no 500'));

      const active = await db.TimeBreak.findAll({ where: { userId: emp.user.id, endedAt: null } });
      assert.strictEqual(active.length, 1, 'concurrency cannot create two active breaks');
    });
  });

  describe('closing the session with an active break', () => {
    it('refuses to close and keeps the session open', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      const empAg = agent();
      await login(empAg, emp.email, emp.password);
      await postForm(empAg, '/time/start', { modality: 'office' });
      await postForm(empAg, '/time/break/start', { type: 'regular' });

      const res = await postForm(empAg, '/time/stop', {});
      assert.ok([302, 303].includes(res.status), 'handled with a redirect, not a crash');

      const entry = await db.TimeEntry.findOne({ where: { userId: emp.user.id } });
      assert.strictEqual(entry.status, 'open', 'session must stay open');
      assert.strictEqual(entry.endedAt, null);

      // After finishing the break, closing works.
      await postForm(empAg, '/time/break/stop', {});
      const ok = await postForm(empAg, '/time/stop', {});
      assert.ok([302, 303].includes(ok.status));
      const closed = await db.TimeEntry.findByPk(entry.id);
      assert.strictEqual(closed.status, 'closed');
    });

    it('refuses at the service level too (ACTIVE_BREAK)', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      const empAg = agent();
      await login(empAg, emp.email, emp.password);
      await postForm(empAg, '/time/start', { modality: 'office' });
      await postForm(empAg, '/time/break/start', { type: 'personal' });

      await assert.rejects(
        () => clock.stopEntry({ models: db, user: emp.user }),
        (err) => err.code === 'ACTIVE_BREAK'
      );
    });
  });

  describe('computation', () => {
    it('computes elapsed, breaks and computed time (30 min countable + 15 min not)', () => {
      const start = new Date('2026-05-04T09:00:00Z');
      const end = new Date('2026-05-04T17:00:00Z');
      const summary = compute.summarize({
        startedAt: start,
        endedAt: end,
        breaks: [
          { startedAt: new Date('2026-05-04T10:00:00Z'), endedAt: new Date('2026-05-04T10:30:00Z'), countsAsWork: true },
          { startedAt: new Date('2026-05-04T12:00:00Z'), endedAt: new Date('2026-05-04T12:15:00Z'), countsAsWork: false },
        ],
        now: end,
      });

      assert.strictEqual(summary.elapsedMinutes, 480, '8 h elapsed');
      assert.strictEqual(summary.breakMinutes, 45, '45 min of breaks');
      assert.strictEqual(summary.countableBreakMinutes, 30);
      assert.strictEqual(summary.nonCountableBreakMinutes, 15);
      assert.strictEqual(summary.computedMinutes, 465, '7 h 45 min computed');
    });

    it('does not count an active non-countable break as worked time', () => {
      const start = new Date('2026-05-04T09:00:00Z');
      const now = new Date('2026-05-04T10:00:00Z');
      const summary = compute.summarize({
        startedAt: start,
        endedAt: null,
        breaks: [{ startedAt: new Date('2026-05-04T09:45:00Z'), endedAt: null, countsAsWork: false }],
        now,
      });
      // 60 min elapsed, 15 min of active personal break already deducted.
      assert.strictEqual(summary.elapsedMinutes, 60);
      assert.strictEqual(summary.breakMinutes, 15);
      assert.strictEqual(summary.computedMinutes, 45);
      assert.strictEqual(summary.hasActiveBreak, true);
      assert.strictEqual(summary.activeBreakCountable, false);
    });

    it('keeps an active countable break as worked time', () => {
      const summary = compute.summarize({
        startedAt: new Date('2026-05-04T09:00:00Z'),
        endedAt: null,
        breaks: [{ startedAt: new Date('2026-05-04T09:45:00Z'), endedAt: null, countsAsWork: true }],
        now: new Date('2026-05-04T10:00:00Z'),
      });
      assert.strictEqual(summary.breakMinutes, 15);
      assert.strictEqual(summary.computedMinutes, 60, 'countable break does not reduce worked time');
    });

    it('works across a DST changeover (real elapsed, not wall clock)', () => {
      const start = new Date('2026-03-29T00:30:00Z'); // 01:30 Madrid (CET)
      const end = new Date('2026-03-29T02:30:00Z');   // 04:30 Madrid (CEST)
      const summary = compute.summarize({
        startedAt: start, endedAt: end,
        breaks: [{ startedAt: new Date('2026-03-29T01:00:00Z'), endedAt: new Date('2026-03-29T01:15:00Z'), countsAsWork: false }],
        now: end,
      });
      assert.strictEqual(summary.elapsedMinutes, 120, 'two real hours');
      assert.strictEqual(summary.computedMinutes, 105);
    });

    it('computes expected minutes in the effective zone, including DST days', () => {
      const normal = compute.expectedMinutesForDay({
        day: '2026-05-04', startTime: '09:00', endTime: '17:00', timezone: 'Europe/Madrid', moment,
      });
      assert.strictEqual(normal, 480);

      // 2026-03-29 is the DST start in Madrid: 00:00-08:00 local is only 7 real hours.
      const dstDay = compute.expectedMinutesForDay({
        day: '2026-03-29', startTime: '00:00', endTime: '08:00', timezone: 'Europe/Madrid', moment,
      });
      assert.strictEqual(dstDay, 420, 'the DST day really has 7 hours between those wall times');
    });
  });

  describe('policy', () => {
    it('defaults to "does not count" for all three types', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const policy = await breaksSvc.getPolicy(db, user.companyId);
      assert.deepStrictEqual(policy, { regular: false, personal: false, justified: false });
    });

    it('saves the policy through the admin page and validates permissions', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);

      let res = await postForm(ag, '/settings/breaks/', { counts_regular: '1', counts_justified: '1' });
      assert.ok([302, 303].includes(res.status));

      let policy = await breaksSvc.getPolicy(db, user.companyId);
      assert.deepStrictEqual(policy, { regular: true, personal: false, justified: true });

      // Unchecking must persist as false (checkbox absent from the body).
      res = await postForm(ag, '/settings/breaks/', {});
      assert.ok([302, 303].includes(res.status));
      policy = await breaksSvc.getPolicy(db, user.companyId);
      assert.deepStrictEqual(policy, { regular: false, personal: false, justified: false });

      // Employees cannot reach it.
      const empAg = agent();
      await login(empAg, emp.email, emp.password);
      const denied = await empAg.get('/settings/breaks/');
      assert.ok([302, 303].includes(denied.status), 'employee redirected away');

      const before = await breaksSvc.getPolicy(db, user.companyId);
      const postDenied = await postForm(empAg, '/settings/breaks/', { counts_regular: '1' });
      assert.ok([302, 303].includes(postDenied.status));
      assert.deepStrictEqual(await breaksSvc.getPolicy(db, user.companyId), before,
        'employee cannot change the policy');
    });

    it('changing the policy never alters already recorded breaks', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);

      // Break taken while "regular" does NOT count.
      const entry = await clock.startEntry({
        models: db, user: emp.user, modality: 'office', now: new Date('2026-05-04T09:00:00Z'),
      });
      const brk = await breaksSvc.startBreak({
        models: db, user: emp.user, type: 'regular', now: new Date('2026-05-04T10:00:00Z'),
      });
      await breaksSvc.stopBreak({ models: db, user: emp.user, now: new Date('2026-05-04T10:30:00Z') });
      await clock.stopEntry({ models: db, user: emp.user, now: new Date('2026-05-04T17:00:00Z') });

      const before = await db.TimeBreak.findByPk(brk.id);
      const beforeSummary = compute.summarize({
        startedAt: entry.startedAt,
        endedAt: (await db.TimeEntry.findByPk(entry.id)).endedAt,
        breaks: [before],
        now: new Date('2026-05-04T17:00:00Z'),
      });
      assert.strictEqual(beforeSummary.computedMinutes, 450, '7h30 computed with a 30 min deduction');

      // Policy flipped afterwards.
      await breaksSvc.setPolicy(db, user.companyId, { regular: true });

      const after = await db.TimeBreak.findByPk(brk.id);
      assert.strictEqual(after.countsAsWork, false, 'snapshot is not rewritten');
      const afterSummary = compute.summarize({
        startedAt: entry.startedAt,
        endedAt: (await db.TimeEntry.findByPk(entry.id)).endedAt,
        breaks: [after],
        now: new Date('2026-05-04T17:00:00Z'),
      });
      assert.strictEqual(afterSummary.computedMinutes, 450, 'closed session unchanged');

      // A new break does follow the new policy.
      await clock.startEntry({ models: db, user: emp.user, modality: 'office', now: new Date() });
      const fresh = await breaksSvc.startBreak({
        models: db, user: emp.user, type: 'regular', now: new Date(),
      });
      assert.strictEqual(fresh.countsAsWork, true, 'new breaks use the current policy');
    });
  });

  describe('security and isolation', () => {
    it('cannot break another employee\'s session (no target parameter honoured)', async () => {
      const ag = agent();
      const { user: admin } = await registerAdmin(ag);
      const empA = await addEmployee(ag, admin.companyId);
      const aAg = agent();
      await login(aAg, empA.email, empA.password);
      await postForm(aAg, '/time/start', { modality: 'office' });

      const empB = await addEmployee(ag, admin.companyId);
      const bAg = agent();
      await login(bAg, empB.email, empB.password);
      await postForm(bAg, '/time/break/start', {
        type: 'regular', userId: empA.user.id, user_id: empA.user.id,
      });

      assert.strictEqual(await db.TimeBreak.count({ where: { userId: empA.user.id } }), 0,
        'A gets no break from B\'s request');
      assert.strictEqual(await db.TimeBreak.count({ where: { userId: empB.user.id } }), 0,
        'B has no open session of their own');
    });

    it('keeps companies isolated: policies and breaks', async () => {
      const aAg = agent();
      const A = await registerAdmin(aAg, { company: 'BrkA' });
      const empA = await addEmployee(aAg, A.user.companyId);
      await postForm(aAg, '/settings/breaks/', { counts_regular: '1' });

      const bAg = agent();
      const B = await registerAdmin(bAg, { company: 'BrkB' });
      const empB = await addEmployee(bAg, B.user.companyId);

      assert.deepStrictEqual(await breaksSvc.getPolicy(db, B.user.companyId),
        { regular: false, personal: false, justified: false }, 'B keeps the default policy');
      assert.deepStrictEqual(await breaksSvc.getPolicy(db, A.user.companyId),
        { regular: true, personal: false, justified: false }, 'A keeps its own policy');

      // B changing its policy does not touch A's.
      await postForm(bAg, '/settings/breaks/', { counts_personal: '1' });
      assert.deepStrictEqual(await breaksSvc.getPolicy(db, A.user.companyId),
        { regular: true, personal: false, justified: false });

      // A's employee break is not visible from B's session context.
      const aEmpAg = agent();
      await login(aEmpAg, empA.email, empA.password);
      await postForm(aEmpAg, '/time/start', { modality: 'office' });
      await postForm(aEmpAg, '/time/break/start', { type: 'regular' });

      const bEmpAg = agent();
      await login(bEmpAg, empB.email, empB.password);
      const page = await bEmpAg.get('/time/');
      assert.ok(page.text.includes('No work sessions recorded yet.'));
      assert.strictEqual(await db.TimeBreak.count({ where: { companyId: B.user.companyId } }), 0);
    });

    it('requires CSRF for break mutations, including multipart', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      const empAg = agent();
      await login(empAg, emp.email, emp.password);
      await postForm(empAg, '/time/start', { modality: 'office' });

      // No token at all.
      const noToken = await empAg.post('/time/break/start').type('form').send({ type: 'regular' });
      assert.strictEqual(noToken.status, 403);
      assert.strictEqual(await db.TimeBreak.count({ where: { userId: emp.user.id } }), 0);

      // Multipart without a token must not slip past the deferred check.
      const multipart = await empAg.post('/time/break/start')
        .field('type', 'regular')
        .field('_csrf', 'not-a-token');
      assert.strictEqual(multipart.status, 403);
      assert.strictEqual(await db.TimeBreak.count({ where: { userId: emp.user.id } }), 0);
    });

    it('ignores client-supplied timestamps and identifiers', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      const empAg = agent();
      await login(empAg, emp.email, emp.password);
      await postForm(empAg, '/time/start', { modality: 'office' });

      const before = Date.now();
      await postForm(empAg, '/time/break/start', {
        type: 'regular',
        started_at: '2001-01-01T00:00:00Z',
        startedAt: '2001-01-01T00:00:00Z',
        companyId: 999999,
        countsAsWork: 'true',
        counts_as_work: 'true',
      });

      const brk = await db.TimeBreak.findOne({ where: { userId: emp.user.id } });
      assert.ok(brk);
      assert.strictEqual(new Date(brk.startedAt).getUTCFullYear() >= 2026, true, 'server time used');
      assert.ok(Math.abs(new Date(brk.startedAt).getTime() - before) < 15000);
      assert.strictEqual(brk.companyId, user.companyId, 'companyId comes from the session');
      assert.strictEqual(brk.countsAsWork, false, 'policy cannot be forced from the client');
    });
  });

  describe('error handling', () => {
    it('rolls back the break when recording its event fails', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      const empAg = agent();
      await login(empAg, emp.email, emp.password);
      await postForm(empAg, '/time/start', { modality: 'office' });

      const original = db.TimeEntryEvent.create;
      db.TimeEntryEvent.create = () => Promise.reject(new Error('simulated event failure'));
      try {
        await assert.rejects(
          () => breaksSvc.startBreak({ models: db, user: emp.user, type: 'regular' }),
          /simulated event failure/
        );
      } finally {
        db.TimeEntryEvent.create = original;
      }

      assert.strictEqual(await db.TimeBreak.count({ where: { userId: emp.user.id } }), 0,
        'the break row is rolled back together with its event');

      // The app still works afterwards.
      const res = await postForm(empAg, '/time/break/start', { type: 'regular' });
      assert.ok([302, 303].includes(res.status));
      assert.strictEqual(await db.TimeBreak.count({ where: { userId: emp.user.id } }), 1);
    });

    it('answers 500 (not a crash) when a query rejects on the time page', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);

      // The break query only runs when the page has at least one session.
      const emp = await addEmployee(ag, user.companyId);
      const empAg = agent();
      await login(empAg, emp.email, emp.password);
      await postForm(empAg, '/time/start', { modality: 'office' });

      const original = db.TimeBreak.findAll;
      db.TimeBreak.findAll = () => Promise.reject(new Error('simulated break query failure'));
      let res;
      try {
        // Requested as the employee: the break query only runs for a user with entries.
        res = await empAg.get('/time/');
      } finally {
        db.TimeBreak.findAll = original;
      }
      assert.strictEqual(res.status, 500, 'handled by the error middleware');
      assert.strictEqual((await empAg.get('/time/')).status, 200, 'the app keeps serving');
    });
  });

  describe('expected hours: when the difference is shown', () => {
    async function openSessionWithSchedule(ag, emp, companyId, days) {
      await seedWeek({ companyId, scopeType: 'company', scopeId: companyId, days });
      const empAg = agent();
      await login(empAg, emp.email, emp.password);
      await postForm(empAg, '/time/start', { modality: 'office' });
      return empAg;
    }

    it('shows a provisional difference when today has a working schedule', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      await db.Company.update({ timezone: 'UTC' }, { where: { id: user.companyId } });

      const weekday = localWeekday('UTC');
      const empAg = await openSessionWithSchedule(ag, emp, user.companyId, [
        { weekday, start: '09:00', end: '17:00' },
      ]);

      const page = await empAg.get('/time/');
      assert.strictEqual(page.status, 200);
      assert.ok(page.text.includes('Expected today'), 'comparison shown');
      assert.ok(/provisional/.test(page.text), 'flagged as provisional while open');
      assert.ok(/not approved overtime/i.test(page.text), 'neutral wording');
    });

    it('reports "not a working day" instead of inventing a deficit', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      await db.Company.update({ timezone: 'UTC' }, { where: { id: user.companyId } });

      const weekday = localWeekday('UTC');
      const empAg = await openSessionWithSchedule(ag, emp, user.companyId, [
        { weekday, off: true },
      ]);

      const page = await empAg.get('/time/');
      assert.ok(/Difference not available: not a working day/.test(page.text));
      assert.ok(/No deficit is assumed/.test(page.text));
    });

    it('reports a bank holiday as unavailable', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      await db.Company.update({ timezone: 'UTC' }, { where: { id: user.companyId } });

      const weekday = localWeekday('UTC');
      await db.BankHoliday.create({
        companyId: user.companyId,
        name: 'Test holiday',
        date: moment.utc().startOf('day').toDate(),
      });

      const empAg = await openSessionWithSchedule(ag, emp, user.companyId, [
        { weekday, start: '09:00', end: '17:00' },
      ]);
      const page = await empAg.get('/time/');
      assert.ok(/Difference not available: company bank holiday/.test(page.text));
    });

    it('reports an approved absence as unavailable (an absence is not worked time)', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      await db.Company.update({ timezone: 'UTC' }, { where: { id: user.companyId } });

      const weekday = localWeekday('UTC');
      const empAg = agent();
      await login(empAg, emp.email, emp.password);
      const lt = await holidayType(user.companyId);
      const leave = await bookLeave(empAg, {
        leaveTypeId: lt.id, userId: emp.user.id,
        from: moment.utc().format('YYYY-MM-DD'), to: moment.utc().format('YYYY-MM-DD'),
      });
      assert.ok(leave, 'absence created');
      await db.Leave.update({ status: db.Leave.status_approved() }, { where: { id: leave.id } });

      await seedWeek({ companyId: user.companyId, scopeType: 'company', scopeId: user.companyId, days: [
        { weekday, start: '09:00', end: '17:00' },
      ] });
      await postForm(empAg, '/time/start', { modality: 'office' });

      const page = await empAg.get('/time/');
      assert.ok(/Difference not available: approved absence/.test(page.text));
    });

    it('reports "no expected schedule" when nothing is configured', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      await db.Company.update({ timezone: 'UTC' }, { where: { id: user.companyId } });
      await db.WorkScheduleDay.destroy({ where: { companyId: user.companyId } });

      const empAg = agent();
      await login(empAg, emp.email, emp.password);
      await postForm(empAg, '/time/start', { modality: 'office' });

      const page = await empAg.get('/time/');
      assert.ok(/Difference not available: no expected schedule/.test(page.text));
    });
  });

  describe('compatibility with block-1 sessions', () => {
    it('computes and renders a session that has no breaks at all', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      const empAg = agent();
      await login(empAg, emp.email, emp.password);

      // Block-1 style session, created directly (no break rows exist).
      const entry = await clock.startEntry({
        models: db, user: emp.user, modality: 'office', now: new Date('2026-05-04T09:00:00Z'),
      });
      await clock.stopEntry({ models: db, user: emp.user, now: new Date('2026-05-04T17:00:00Z') });

      const closed = await db.TimeEntry.findByPk(entry.id);
      const summary = compute.summarize({
        startedAt: closed.startedAt, endedAt: closed.endedAt, breaks: [], now: closed.endedAt,
      });
      assert.strictEqual(summary.breakMinutes, 0);
      assert.strictEqual(summary.computedMinutes, summary.elapsedMinutes);

      const page = await empAg.get('/time/');
      assert.strictEqual(page.status, 200);
      assert.ok(page.text.includes('Recent sessions'));
      assert.strictEqual(await db.TimeBreak.count({ where: { timeEntryId: entry.id } }), 0);
    });
  });
});