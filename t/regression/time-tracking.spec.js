'use strict';

/*
 * Time tracking — block 1 regression tests.
 *
 * Covers the 14 required checks plus regressions for the six findings of the
 * independent audit (F1 employee removal data loss, F2 multipart CSRF bypass,
 * F3 async rejection killing the process, F4 non-working vs inherit, F5 weekday
 * in the effective timezone, F6 clock-out before clock-in on SQLite).
 */

const assert = require('assert');
const H = require('./helper');
const { agent, db, postForm, registerAdmin, addEmployee, login, holidayType, bookLeave } = H;

const scheduleUtil = require('../../lib/modules/time/schedule');
const clock = require('../../lib/modules/time/clock');

async function setCompanyTimezone(companyId, tz) {
  await db.Company.update({ timezone: tz }, { where: { id: companyId } });
}

/**
 * Seed a scope's week. `days` entries: { weekday, start, end } for a working day
 * or { weekday, off: true } for an explicit non-working day.
 */
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

const MON_TO_FRI = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' }));

describe('time tracking — block 1', function () {

  describe('migrations and schema', () => {
    it('creates the three new tables in the migrated test database', async () => {
      const tables = await db.sequelize.getQueryInterface().showAllTables();
      const names = tables.map((t) => (typeof t === 'string' ? t : (t.tableName || t.name)));
      ['time_entries', 'time_entry_events', 'work_schedule_days'].forEach((t) => {
        assert.ok(names.includes(t), 'missing table ' + t + ' (have: ' + names.join(',') + ')');
      });
    });
  });

  describe('start and stop a session', () => {
    it('starts a session, persists it and records an "in" event', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      const empAg = agent();
      await login(empAg, emp.email, emp.password);

      const before = Date.now();
      const res = await postForm(empAg, '/time/start', { modality: 'remote' });
      assert.ok([302, 303].includes(res.status), 'start redirects, got ' + res.status);

      const entry = await db.TimeEntry.findOne({
        where: { userId: emp.user.id }, order: [['id', 'DESC']],
      });
      assert.ok(entry, 'entry persisted');
      assert.strictEqual(entry.status, 'open');
      assert.strictEqual(entry.modality, 'remote');
      assert.strictEqual(entry.companyId, user.companyId, 'entry scoped to the company');

      const events = await db.TimeEntryEvent.findAll({ where: { timeEntryId: entry.id } });
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].type, 'in');
      assert.strictEqual(events[0].source, 'direct');

      const startedMs = new Date(entry.startedAt).getTime();
      assert.ok(Math.abs(startedMs - before) < 15000, 'started_at comes from the server clock');
    });

    it('ignores a browser-supplied start time', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      const empAg = agent();
      await login(empAg, emp.email, emp.password);

      const before = Date.now();
      await postForm(empAg, '/time/start', {
        modality: 'office',
        started_at: '2001-01-01T00:00:00Z',
        startedAt: '2001-01-01T00:00:00Z',
      });

      const entry = await db.TimeEntry.findOne({ where: { userId: emp.user.id } });
      assert.ok(entry);
      const startedMs = new Date(entry.startedAt).getTime();
      assert.ok(Math.abs(startedMs - before) < 15000, 'client-sent time must be ignored');
      assert.ok(new Date(entry.startedAt).getUTCFullYear() >= 2026, 'not the injected year');
    });

    it('stops the session, sets the end time after the start and records an "out" event', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      const empAg = agent();
      await login(empAg, emp.email, emp.password);

      await postForm(empAg, '/time/start', { modality: 'travel' });
      const res = await postForm(empAg, '/time/stop', {});
      assert.ok([302, 303].includes(res.status));

      const entry = await db.TimeEntry.findOne({ where: { userId: emp.user.id } });
      assert.strictEqual(entry.status, 'closed');
      assert.ok(entry.endedAt, 'ended_at set');
      assert.ok(new Date(entry.endedAt).getTime() >= new Date(entry.startedAt).getTime(),
        'end is not before start');

      const events = await db.TimeEntryEvent.findAll({
        where: { timeEntryId: entry.id }, order: [['id', 'ASC']],
      });
      assert.deepStrictEqual(events.map((e) => e.type), ['in', 'out']);
    });

    it('refuses to finish when there is no open session', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      const empAg = agent();
      await login(empAg, emp.email, emp.password);

      const res = await postForm(empAg, '/time/stop', {});
      assert.ok([302, 303].includes(res.status), 'handled with a redirect');
      const count = await db.TimeEntry.count({ where: { userId: emp.user.id } });
      assert.strictEqual(count, 0, 'no entry created by a stray stop');
    });

    // F6 — SQLite has no CHECK constraint, so the service must enforce it.
    it('rejects a clock-out earlier than the clock-in (SQLite has no CHECK)', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      const empAg = agent();
      await login(empAg, emp.email, emp.password);

      const start = new Date('2026-05-04T10:00:00Z');
      const entry = await clock.startEntry({ models: db, user: emp.user, modality: 'office', now: start });

      await assert.rejects(
        () => clock.stopEntry({ models: db, user: emp.user, now: new Date('2026-05-04T09:59:59Z') }),
        (err) => err.code === 'INVALID_END',
        'an end before the start must be rejected'
      );

      const stillOpen = await db.TimeEntry.findByPk(entry.id);
      assert.strictEqual(stillOpen.status, 'open', 'session stays open');
      assert.strictEqual(stillOpen.endedAt, null, 'no end time written');
      const outs = await db.TimeEntryEvent.count({ where: { timeEntryId: entry.id, type: 'out' } });
      assert.strictEqual(outs, 0, 'no "out" event recorded');
    });
  });

  describe('one open session per employee', () => {
    it('does not create a second open session and keeps the first intact', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      const empAg = agent();
      await login(empAg, emp.email, emp.password);

      await postForm(empAg, '/time/start', { modality: 'office' });
      const first = await db.TimeEntry.findOne({ where: { userId: emp.user.id } });

      await postForm(empAg, '/time/start', { modality: 'remote' });

      const open = await db.TimeEntry.findAll({ where: { userId: emp.user.id, status: 'open' } });
      assert.strictEqual(open.length, 1, 'exactly one open session');
      assert.strictEqual(open[0].id, first.id, 'the original session is untouched');
      assert.strictEqual(open[0].modality, 'office', 'modality not overwritten');

      const total = await db.TimeEntry.count({ where: { userId: emp.user.id } });
      assert.strictEqual(total, 1, 'no extra row created');
    });

    it('is enforced in the database under concurrent requests (double click / two devices)', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);

      const ag1 = agent();
      const ag2 = agent();
      await login(ag1, emp.email, emp.password);
      await login(ag2, emp.email, emp.password);

      const results = await Promise.all([
        postForm(ag1, '/time/start', { modality: 'office' }),
        postForm(ag2, '/time/start', { modality: 'office' }),
      ]);
      results.forEach((r) => assert.ok([302, 303].includes(r.status), 'both handled, no 500'));

      const open = await db.TimeEntry.findAll({ where: { userId: emp.user.id, status: 'open' } });
      assert.strictEqual(open.length, 1, 'concurrency cannot create two open sessions');

      await assert.rejects(
        () => db.TimeEntry.create({
          companyId: user.companyId, userId: emp.user.id, modality: 'office',
          status: 'open', startedAt: new Date(), endedAt: null,
        }),
        /unique|constraint/i,
        'database rejects a second open row'
      );
    });
  });

  describe('authorization and multi-tenant isolation', () => {
    it('cannot stop another employee\'s session (no target parameter is honoured)', async () => {
      const ag = agent();
      const { user: admin } = await registerAdmin(ag);
      const empA = await addEmployee(ag, admin.companyId);

      const aAg = agent();
      await login(aAg, empA.email, empA.password);
      await postForm(aAg, '/time/start', { modality: 'office' });
      const openA = await db.TimeEntry.findOne({ where: { userId: empA.user.id, status: 'open' } });

      const empB = await addEmployee(ag, admin.companyId);
      const bAg = agent();
      await login(bAg, empB.email, empB.password);
      await postForm(bAg, '/time/stop', { userId: empA.user.id, user_id: empA.user.id, id: openA.id });

      const stillOpen = await db.TimeEntry.findByPk(openA.id);
      assert.strictEqual(stillOpen.status, 'open', 'A\'s session must stay open');
      const bEntries = await db.TimeEntry.count({ where: { userId: empB.user.id } });
      assert.strictEqual(bEntries, 0, 'B has no entries');
    });

    it('keeps company A and company B sessions isolated', async () => {
      const aAg = agent();
      const A = await registerAdmin(aAg, { company: 'TimeA' });
      const empA = await addEmployee(aAg, A.user.companyId);
      const aeAg = agent();
      await login(aeAg, empA.email, empA.password);
      await postForm(aeAg, '/time/start', { modality: 'office' });
      const aEntry = await db.TimeEntry.findOne({ where: { userId: empA.user.id } });

      const bAg = agent();
      const B = await registerAdmin(bAg, { company: 'TimeB' });
      const empB = await addEmployee(bAg, B.user.companyId);
      const beAg = agent();
      await login(beAg, empB.email, empB.password);

      const page = await beAg.get('/time/');
      assert.strictEqual(page.status, 200);

      // Strong, data-level assertion: B's screen renders only B's own sessions.
      assert.ok(page.text.includes('No work sessions recorded yet.'),
        'B\'s screen must show an empty history, not A\'s session');
      const bEntryIds = (page.text.match(/time_entry_id=\d+/g) || []);
      assert.strictEqual(bEntryIds.length, 0);

      const bEntries = await db.TimeEntry.count({ where: { companyId: B.user.companyId } });
      assert.strictEqual(bEntries, 0, 'B has no entries of its own');

      const aEntries = await db.TimeEntry.findAll({ where: { companyId: A.user.companyId } });
      assert.strictEqual(aEntries.length, 1);
      assert.strictEqual(aEntries[0].companyId, A.user.companyId);
      assert.strictEqual(aEntries[0].id, aEntry.id);
    });

    it('rejects unauthenticated access to the page and the actions', async () => {
      const anon = agent();
      const page = await anon.get('/time/');
      assert.ok([302, 303].includes(page.status), 'page redirects, got ' + page.status);

      const before = await db.TimeEntry.count();
      const start = await anon.post('/time/start').type('form').send({ modality: 'office' });
      assert.ok([302, 303, 403].includes(start.status), 'start refused, got ' + start.status);
      assert.strictEqual(await db.TimeEntry.count(), before, 'nothing created anonymously');
    });

    it('non-admin employees cannot open the schedule administration', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      const empAg = agent();
      await login(empAg, emp.email, emp.password);

      const res = await empAg.get('/time/schedule/');
      assert.ok([302, 303].includes(res.status), 'redirected away, got ' + res.status);
    });

    it('rejects a start without a CSRF token', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      const empAg = agent();
      await login(empAg, emp.email, emp.password);

      const res = await empAg.post('/time/start').type('form').send({ modality: 'office' });
      assert.strictEqual(res.status, 403, 'CSRF required');
      assert.strictEqual(await db.TimeEntry.count({ where: { userId: emp.user.id } }), 0);
    });

    // F2 — a multipart body must not be a way to skip the CSRF check.
    it('rejects multipart requests without a token on the time routes (no CSRF bypass)', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      const empAg = agent();
      await login(empAg, emp.email, emp.password);
      await postForm(empAg, '/time/start', { modality: 'office' });

      // Clock-out sent as multipart, without any token.
      const stop = await empAg.post('/time/stop')
        .field('modality', 'office');
      assert.strictEqual(stop.status, 403, 'multipart stop without token is rejected');
      const entry = await db.TimeEntry.findOne({ where: { userId: emp.user.id } });
      assert.strictEqual(entry.status, 'open', 'session must stay open');

      // Schedule template sent as multipart, without any token.
      await seedWeek({ companyId: user.companyId, scopeType: 'company', scopeId: user.companyId, days: MON_TO_FRI });
      const tpl = await ag.post('/time/schedule/template/')
        .field('scope', 'company');
      assert.strictEqual(tpl.status, 403, 'multipart template without token is rejected');
      const tuesday = await db.WorkScheduleDay.findOne({
        where: { companyId: user.companyId, scopeType: 'company', weekday: 2 },
      });
      assert.ok(tuesday, 'existing schedule untouched');
      assert.strictEqual(tuesday.startTime, '09:00', 'schedule not replaced via multipart');

      // And a multipart wipe attempt on the schedule save route.
      const wipe = await ag.post('/time/schedule/')
        .field('scope', 'company')
        .field('mode_1', 'off');
      assert.strictEqual(wipe.status, 403, 'multipart schedule save without token is rejected');
      assert.strictEqual(await db.WorkScheduleDay.count({
        where: { companyId: user.companyId, scopeType: 'company' },
      }), 5, 'week not wiped');
    });

    it('still accepts the CSV import route (the only multipart endpoint) with a body token', async () => {
      const ag = agent();
      const { user: admin } = await registerAdmin(ag, { email: `csvtok-${Date.now()}@example.com` });
      const token = await H.freshCsrf(ag);
      const csv = 'email,lastname,name,department\n' +
        `mp-${Date.now()}@example.com,Last,First,Sales\n`;

      const res = await ag.post('/users/import/')
        .attach('users_import', Buffer.from(csv), 'u.csv')
        .field('_csrf', token);
      assert.ok([302, 303].includes(res.status), 'import still works, got ' + res.status);
      assert.ok(admin.companyId);
    });
  });

  describe('modality validation', () => {
    it('accepts exactly office/remote/travel and rejects anything else', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      const empAg = agent();
      await login(empAg, emp.email, emp.password);

      for (const bad of ['', 'home', 'OFFICE', 'on-site', 'office;drop']) {
        await postForm(empAg, '/time/start', { modality: bad });
        const n = await db.TimeEntry.count({ where: { userId: emp.user.id } });
        assert.strictEqual(n, 0, 'invalid modality "' + bad + '" must not create an entry');
      }

      for (const good of ['office', 'remote', 'travel']) {
        await postForm(empAg, '/time/start', { modality: good });
        const entry = await db.TimeEntry.findOne({
          where: { userId: emp.user.id, status: 'open' },
        });
        assert.ok(entry, 'valid modality ' + good + ' creates a session');
        assert.strictEqual(entry.modality, good);
        await postForm(empAg, '/time/stop', {});
      }
    });

    it('exposes the product labels (office/remote/travel)', () => {
      assert.deepStrictEqual(clock.MODALITY_VALUES, ['office', 'remote', 'travel']);
      assert.strictEqual(clock.modalityLabel('office'), 'Office');
      assert.strictEqual(clock.modalityLabel('remote'), 'Remote');
      assert.strictEqual(clock.modalityLabel('travel'), 'Travel');
    });
  });

  describe('expected schedule hierarchy (employee > department > company)', () => {
    it('resolves the most specific scope per weekday', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      const companyId = user.companyId;

      await seedWeek({ companyId, scopeType: 'company', scopeId: companyId, days: MON_TO_FRI });

      const freshUser = await db.User.findByPk(emp.user.id);
      const monday = new Date('2026-03-02T10:00:00Z');

      let resolved = await scheduleUtil.resolveScheduleForUser({
        models: db, user: freshUser, date: monday, timezone: 'UTC',
      });
      assert.strictEqual(resolved.source, 'company');
      assert.strictEqual(resolved.working, true);
      assert.strictEqual(resolved.startTime, '09:00');

      await seedWeek({ companyId, scopeType: 'department', scopeId: freshUser.DepartmentId, days: [
        { weekday: 1, start: '08:00', end: '16:00' },
      ] });
      resolved = await scheduleUtil.resolveScheduleForUser({
        models: db, user: freshUser, date: monday, timezone: 'UTC',
      });
      assert.strictEqual(resolved.source, 'department');
      assert.strictEqual(resolved.startTime, '08:00');

      await seedWeek({ companyId, scopeType: 'user', scopeId: freshUser.id, days: [
        { weekday: 1, start: '07:30', end: '15:30' },
      ] });
      resolved = await scheduleUtil.resolveScheduleForUser({
        models: db, user: freshUser, date: monday, timezone: 'UTC',
      });
      assert.strictEqual(resolved.source, 'user');
      assert.strictEqual(resolved.startTime, '07:30');

      const saturday = new Date('2026-03-07T10:00:00Z');
      resolved = await scheduleUtil.resolveScheduleForUser({
        models: db, user: freshUser, date: saturday, timezone: 'UTC',
      });
      assert.strictEqual(resolved, null, 'nothing configured for Saturday');
    });

    // F4 — an explicitly disabled day must not inherit the company hours.
    it('honours explicit non-working days instead of inheriting (part-time week)', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      const companyId = user.companyId;

      await seedWeek({ companyId, scopeType: 'company', scopeId: companyId, days: MON_TO_FRI });

      // Employee works Monday only: Tue-Fri are explicitly not working days.
      await seedWeek({ companyId, scopeType: 'user', scopeId: emp.user.id, days: [
        { weekday: 1, start: '09:00', end: '13:00' },
        { weekday: 2, off: true },
        { weekday: 3, off: true },
        { weekday: 4, off: true },
        { weekday: 5, off: true },
      ] });

      const freshUser = await db.User.findByPk(emp.user.id);
      const monday = await scheduleUtil.resolveScheduleForUser({
        models: db, user: freshUser, date: new Date('2026-03-02T10:00:00Z'), timezone: 'UTC',
      });
      assert.strictEqual(monday.working, true);
      assert.strictEqual(monday.startTime, '09:00');
      assert.strictEqual(monday.endTime, '13:00');

      const tuesday = await scheduleUtil.resolveScheduleForUser({
        models: db, user: freshUser, date: new Date('2026-03-03T10:00:00Z'), timezone: 'UTC',
      });
      assert.ok(tuesday, 'an explicit row exists for Tuesday');
      assert.strictEqual(tuesday.working, false, 'Tuesday is explicitly non-working, not inherited');
      assert.strictEqual(tuesday.source, 'user');

      // And the same through the admin route: saving "off" persists a barrier.
      const body = { scope: 'user:' + emp.user.id };
      [1, 2, 3, 4, 5, 6, 7].forEach((wd) => { body['mode_' + wd] = wd === 1 ? 'work' : 'off'; });
      body['start_1'] = '09:00';
      body['end_1'] = '13:00';
      const res = await postForm(ag, '/time/schedule/', body);
      assert.ok([302, 303].includes(res.status));
      assert.strictEqual(await db.WorkScheduleDay.count({
        where: { companyId, scopeType: 'user', scopeId: emp.user.id, isWorkingDay: false },
      }), 6, 'six explicit non-working days stored');
    });

    // F5 — the weekday must be the local one, not the UTC one.
    it('resolves the weekday in the effective timezone, not in UTC', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      const companyId = user.companyId;

      // Only Monday configured (both in UTC terms and Madrid terms).
      await seedWeek({ companyId, scopeType: 'company', scopeId: companyId, days: [
        { weekday: 1, start: '09:00', end: '17:00' },
      ] });

      const freshUser = await db.User.findByPk(emp.user.id);
      // 2026-03-01T23:30Z is Sunday in UTC but Monday 00:30 in Madrid.
      const instant = new Date('2026-03-01T23:30:00Z');

      const inMadrid = await scheduleUtil.resolveScheduleForUser({
        models: db, user: freshUser, date: instant, timezone: 'Europe/Madrid',
      });
      assert.ok(inMadrid, 'Madrid sees Monday and resolves the Monday schedule');
      assert.strictEqual(inMadrid.weekday, 1);
      assert.strictEqual(inMadrid.startTime, '09:00');

      const inUtc = await scheduleUtil.resolveScheduleForUser({
        models: db, user: freshUser, date: instant, timezone: 'UTC',
      });
      assert.strictEqual(inUtc, null, 'UTC sees Sunday, which has no schedule');

      // And through the HTTP page, with the company timezone set accordingly.
      await setCompanyTimezone(companyId, 'Europe/Madrid');
      const empAg = agent();
      await login(empAg, emp.email, emp.password);
      const page = await empAg.get('/time/');
      assert.strictEqual(page.status, 200);
      assert.ok(/Europe\/Madrid/.test(page.text), 'page states the effective timezone');
    });

    it('lets an administrator save a week and rejects an invalid range', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);

      const body = { scope: 'company' };
      [1, 2, 3, 4, 5].forEach((d) => {
        body['mode_' + d] = 'work';
        body['start_' + d] = '09:00';
        body['end_' + d] = '17:00';
      });
      let res = await postForm(ag, '/time/schedule/', body);
      assert.ok([302, 303].includes(res.status));
      assert.strictEqual(await db.WorkScheduleDay.count({
        where: { companyId: user.companyId, scopeType: 'company' },
      }), 5, 'five working days saved');

      const bad = Object.assign({}, body);
      bad['start_1'] = '18:00';
      bad['end_1'] = '09:00';
      res = await postForm(ag, '/time/schedule/', bad);
      assert.ok([302, 303].includes(res.status), 'invalid input handled with a redirect');
      assert.strictEqual(await db.WorkScheduleDay.count({
        where: { companyId: user.companyId, scopeType: 'company' },
      }), 5, 'existing schedule preserved after a rejected save');
    });

    it('never lets one company configure another company\'s employee', async () => {
      const aAg = agent();
      const A = await registerAdmin(aAg, { company: 'SchedA' });
      const aEmp = await addEmployee(aAg, A.user.companyId);

      const bAg = agent();
      await registerAdmin(bAg, { company: 'SchedB' });

      const body = { scope: 'user:' + aEmp.user.id, mode_1: 'work', start_1: '09:00', end_1: '17:00' };
      const res = await postForm(bAg, '/time/schedule/', body);
      assert.ok([302, 303].includes(res.status));

      const rows = await db.WorkScheduleDay.count({
        where: { scopeType: 'user', scopeId: aEmp.user.id },
      });
      assert.strictEqual(rows, 0, 'cross-company schedule write must not persist');
    });
  });

  describe('timezone presentation', () => {
    it('renders instants in the company timezone, keeping UTC instants unambiguous', async () => {
      const instant = new Date('2026-03-02T09:30:00Z');
      assert.strictEqual(scheduleUtil.formatTimeInZone(instant, 'UTC'), '09:30');
      assert.strictEqual(scheduleUtil.formatTimeInZone(instant, 'Europe/Madrid'), '10:30');
      assert.strictEqual(scheduleUtil.formatTimeInZone(instant, 'America/New_York'), '04:30');

      const ag = agent();
      const { user } = await registerAdmin(ag);
      await setCompanyTimezone(user.companyId, 'Europe/Madrid');
      const emp = await addEmployee(ag, user.companyId);
      const empAg = agent();
      await login(empAg, emp.email, emp.password);
      await postForm(empAg, '/time/start', { modality: 'office' });

      const page = await empAg.get('/time/');
      assert.strictEqual(page.status, 200);
      assert.ok(page.text.includes('Europe/Madrid'), 'page states the effective timezone');

      const entry = await db.TimeEntry.findOne({ where: { userId: emp.user.id } });
      assert.ok(entry.startedAt instanceof Date, 'stored as a Date (UTC instant)');
    });

    it('falls back to the company timezone, then UTC', () => {
      assert.strictEqual(scheduleUtil.resolveTimezone({ company: { timezone: 'Europe/Madrid' } }), 'Europe/Madrid');
      assert.strictEqual(
        scheduleUtil.resolveTimezone({ workCenter: { timezone: 'Europe/Lisbon' }, company: { timezone: 'Europe/Madrid' } }),
        'Europe/Lisbon', 'work centre wins over company'
      );
      assert.strictEqual(scheduleUtil.resolveTimezone({}), 'UTC');
    });
  });

  describe('resilience', () => {
    // F3 — a rejected promise in an async handler must not kill the process.
    it('answers 500 (not a process exit) when a query rejects inside GET /time/', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      await addEmployee(ag, user.companyId);

      const original = db.WorkScheduleDay.findAll;
      db.WorkScheduleDay.findAll = () => Promise.reject(new Error('simulated database failure'));
      let res;
      try {
        res = await ag.get('/time/');
      } finally {
        db.WorkScheduleDay.findAll = original;
      }

      assert.strictEqual(res.status, 500, 'error is handled by the error middleware');
      // The process is still alive and serving: this very assertion runs after it.
      const after = await ag.get('/time/');
      assert.strictEqual(after.status, 200, 'the app keeps serving after the failure');
    });
  });

  // F1 — removing an employee must not lose absences nor clock history.
  describe('employee removal with recorded data', () => {
    it('refuses to delete an employee with time sessions, keeping absences and history', async () => {
      const ag = agent();
      const { user: admin } = await registerAdmin(ag);
      const emp = await addEmployee(ag, admin.companyId);

      const empAg = agent();
      await login(empAg, emp.email, emp.password);
      const lt = await holidayType(admin.companyId);
      const leave = await bookLeave(empAg, {
        leaveTypeId: lt.id, userId: emp.user.id, from: '2026-12-01', to: '2026-12-01',
      });
      assert.ok(leave, 'approved/pending absence created');
      await postForm(empAg, '/time/start', { modality: 'office' });
      await postForm(empAg, '/time/stop', {});

      const leavesBefore = await db.Leave.count({ where: { userId: emp.user.id } });
      const entriesBefore = await db.TimeEntry.count({ where: { userId: emp.user.id } });
      assert.ok(leavesBefore > 0 && entriesBefore > 0, 'fixture has both absences and sessions');

      const res = await postForm(ag, '/users/delete/' + emp.user.id + '/', {});
      assert.ok([302, 303].includes(res.status), 'handled with a redirect');

      const stillThere = await db.User.findByPk(emp.user.id);
      assert.ok(stillThere, 'employee is NOT removed');
      assert.strictEqual(await db.Leave.count({ where: { userId: emp.user.id } }), leavesBefore,
        'absences are NOT lost');
      assert.strictEqual(await db.TimeEntry.count({ where: { userId: emp.user.id } }), entriesBefore,
        'clock history is preserved');
      assert.strictEqual(await db.TimeEntryEvent.count({ where: { userId: emp.user.id } }), 2,
        'both clock events preserved');
    });

    it('still removes an employee without sessions (absences included) in one transaction', async () => {
      const ag = agent();
      const { user: admin } = await registerAdmin(ag);
      const emp = await addEmployee(ag, admin.companyId);

      const empAg = agent();
      await login(empAg, emp.email, emp.password);
      const lt = await holidayType(admin.companyId);
      await bookLeave(empAg, {
        leaveTypeId: lt.id, userId: emp.user.id, from: '2026-12-05', to: '2026-12-05',
      });

      const res = await postForm(ag, '/users/delete/' + emp.user.id + '/', {});
      assert.ok([302, 303].includes(res.status));

      assert.strictEqual(await db.User.findByPk(emp.user.id), null, 'employee removed');
      assert.strictEqual(await db.Leave.count({ where: { userId: emp.user.id } }), 0, 'absences removed with them');
    });
  });

  describe('employee screen', () => {
    it('shows the expected schedule and the open session', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      const empAg = agent();
      await login(empAg, emp.email, emp.password);

      const weekday = new Date().getUTCDay() === 0 ? 7 : new Date().getUTCDay();
      await seedWeek({
        companyId: user.companyId, scopeType: 'company', scopeId: user.companyId,
        days: [{ weekday, start: '09:00', end: '17:00' }],
      });

      let page = await empAg.get('/time/');
      assert.strictEqual(page.status, 200);
      assert.ok(page.text.includes('Start work session'));
      assert.ok(page.text.includes('09:00'), 'expected schedule visible');

      await postForm(empAg, '/time/start', { modality: 'remote' });
      page = await empAg.get('/time/');
      assert.strictEqual(page.status, 200);
      assert.ok(page.text.includes('Finish work session'), 'open session state');
      assert.ok(page.text.includes('Remote'), 'modality shown');

      await postForm(empAg, '/time/stop', {});
      page = await empAg.get('/time/');
      assert.ok(page.text.includes('Recent sessions'));
    });
  });
});