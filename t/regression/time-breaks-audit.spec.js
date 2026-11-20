'use strict';

/*
 * Regressions for the six findings of the block-2 audit.
 *
 *  F01 — starting a break and closing the session share a lock, so the interleaving
 *        that left a closed session with an active break is impossible.
 *  F02 — a break cannot start before the previous break of the same session ends.
 *  F03 — saved break policies render as checked.
 *  F04 — the daily comparison aggregates every session of the LOCAL day and clips
 *        sessions that cross midnight.
 *  F05 — bank holidays / absences are civil dates stored at 00:00 UTC; they are
 *        compared in the same representation, in any timezone.
 *  F06 — the migration runs in one transaction, so a mid-way failure rolls back and
 *        a retry succeeds.
 */

const assert = require('assert');
const moment = require('moment-timezone');
const H = require('./helper');
const { agent, db, postForm, registerAdmin, addEmployee, login, bookLeave, holidayType } = H;

const clock = require('../../lib/modules/time/clock');
const breaksSvc = require('../../lib/modules/time/breaks');
const compute = require('../../lib/modules/time/compute');
const { Sequelize } = require('sequelize');

async function seedWeek({ companyId, scopeType, scopeId, days }) {
  await db.WorkScheduleDay.destroy({ where: { companyId, scopeType, scopeId } });
  await db.WorkScheduleDay.bulkCreate(days.map((d) => ({
    companyId, scopeType, scopeId,
    weekday: d.weekday,
    isWorkingDay: !d.off,
    startTime: d.off ? null : d.start,
    endTime: d.off ? null : d.end,
  })));
}

function localWeekday(zone) {
  return moment.utc().tz(zone || 'UTC').isoWeekday();
}

describe('block-2 audit regressions', function () {

  describe('F01 — break start and clock-out are serialised', () => {
    it('refuses to close a session that has an active break committed by another request', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);

      const entry = await clock.startEntry({
        models: db, user: emp.user, modality: 'office', now: new Date('2026-05-04T09:00:00Z'),
      });

      // Simulate the race: another request committed an active break after the
      // clock-out had already read "no active break".
      await db.TimeBreak.create({
        companyId: user.companyId,
        userId: emp.user.id,
        timeEntryId: entry.id,
        type: 'regular',
        countsAsWork: false,
        startedAt: new Date('2026-05-04T12:00:01Z'),
        endedAt: null,
      });

      await assert.rejects(
        () => clock.stopEntry({ models: db, user: emp.user, now: new Date('2026-05-04T12:00:00Z') }),
        (err) => err.code === 'ACTIVE_BREAK',
        'the session must not close with an active break'
      );

      const stillOpen = await db.TimeEntry.findByPk(entry.id);
      assert.strictEqual(stillOpen.status, 'open', 'session stays open');
      assert.strictEqual(stillOpen.endedAt, null, 'no end time written');
      const outs = await db.TimeEntryEvent.count({ where: { timeEntryId: entry.id, type: 'out' } });
      assert.strictEqual(outs, 0, 'no "out" event recorded');

      // After the break is closed, the session can be closed normally.
      await breaksSvc.stopBreak({ models: db, user: emp.user, now: new Date('2026-05-04T12:01:00Z') });
      const closed = await clock.stopEntry({ models: db, user: emp.user, now: new Date('2026-05-04T17:00:00Z') });
      assert.strictEqual(closed.status, 'closed');
    });

    it('does not create a break on a session that is already closed', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);

      const entry = await clock.startEntry({
        models: db, user: emp.user, modality: 'office', now: new Date('2026-05-04T09:00:00Z'),
      });
      await clock.stopEntry({ models: db, user: emp.user, now: new Date('2026-05-04T17:00:00Z') });

      await assert.rejects(
        () => breaksSvc.startBreak({ models: db, user: emp.user, type: 'regular', now: new Date() }),
        (err) => err.code === 'NO_OPEN_ENTRY'
      );
      assert.strictEqual(await db.TimeBreak.count({ where: { timeEntryId: entry.id } }), 0);
    });
  });

  describe('F07 — clock-out stays after the end of every break', () => {
    it('rejects a delayed clock-out after a break finishes and allows the boundary', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      const entry = await clock.startEntry({
        models: db, user: emp.user, modality: 'office', now: new Date('2026-05-04T09:00:00Z'),
      });
      await breaksSvc.startBreak({
        models: db, user: emp.user, type: 'regular', now: new Date('2026-05-04T10:00:00Z'),
      });

      // The clock-out has captured its timestamp but waits for a connection.
      let release;
      let reached;
      const waiting = new Promise((resolve) => { reached = resolve; });
      const proceed = new Promise((resolve) => { release = resolve; });
      const originalTransaction = db.sequelize.transaction;
      db.sequelize.transaction = async function (...args) {
        reached();
        await proceed;
        return originalTransaction.apply(this, args);
      };
      const delayedStop = clock.stopEntry({
        models: db, user: emp.user, now: new Date('2026-05-04T10:15:00Z'),
      });
      try {
        await waiting;
        db.sequelize.transaction = originalTransaction;
        await breaksSvc.stopBreak({
          models: db, user: emp.user, now: new Date('2026-05-04T10:30:00Z'),
        });
      } finally {
        db.sequelize.transaction = originalTransaction;
        release();
      }

      await assert.rejects(delayedStop, (err) => err.code === 'BREAK_AFTER_END');
      const stillOpen = await db.TimeEntry.findByPk(entry.id);
      assert.strictEqual(stillOpen.status, 'open');
      assert.strictEqual(stillOpen.endedAt, null);
      assert.strictEqual(await db.TimeEntryEvent.count({
        where: { timeEntryId: entry.id, type: 'out' },
      }), 0, 'a rejected clock-out must not create an event');

      // A session may end at the exact instant its final break ends.
      const closed = await clock.stopEntry({
        models: db, user: emp.user, now: new Date('2026-05-04T10:30:00Z'),
      });
      assert.strictEqual(closed.endedAt.toISOString(), '2026-05-04T10:30:00.000Z');
      assert.strictEqual(await db.TimeEntryEvent.count({
        where: { timeEntryId: entry.id, type: 'out' },
      }), 1);
    });
  });

  describe('policy transaction', () => {
    it('returns the newly saved policy from the same transaction', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const result = await breaksSvc.setPolicy(db, user.companyId, {
        regular: true, personal: false, justified: true,
      });
      assert.deepStrictEqual(result, { regular: true, personal: false, justified: true });
      assert.deepStrictEqual(await breaksSvc.getPolicy(db, user.companyId), result);
    });

    it('keeps concurrent policy saves as complete configurations', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      await breaksSvc.setPolicy(db, user.companyId, {
        regular: false, personal: false, justified: false,
      });
      const first = { regular: true, personal: false, justified: false };
      const second = { regular: false, personal: true, justified: false };

      await Promise.all([
        breaksSvc.setPolicy(db, user.companyId, first),
        breaksSvc.setPolicy(db, user.companyId, second),
      ]);

      const saved = await breaksSvc.getPolicy(db, user.companyId);
      assert.ok(
        JSON.stringify(saved) === JSON.stringify(first) || JSON.stringify(saved) === JSON.stringify(second),
        'the final policy must match one complete submitted configuration'
      );
    });
  });

  describe('F02 — a break cannot overlap the previous one', () => {
    it('rejects a break whose start is before the previous break ended', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);

      const entry = await clock.startEntry({
        models: db, user: emp.user, modality: 'office', now: new Date('2026-05-04T09:00:00Z'),
      });

      // First break 10:00 - 10:30.
      await breaksSvc.startBreak({ models: db, user: emp.user, type: 'regular', now: new Date('2026-05-04T10:00:00Z') });
      await breaksSvc.stopBreak({ models: db, user: emp.user, now: new Date('2026-05-04T10:30:00Z') });

      // Second request captured 10:15 before the first break closed: must be refused.
      await assert.rejects(
        () => breaksSvc.startBreak({ models: db, user: emp.user, type: 'personal', now: new Date('2026-05-04T10:15:00Z') }),
        (err) => err.code === 'OVERLAPS_PREVIOUS',
        'a break may not start before the previous break ends'
      );

      const rows = await db.TimeBreak.findAll({ where: { timeEntryId: entry.id }, order: [['id', 'ASC']] });
      assert.strictEqual(rows.length, 1, 'the invalid break is not persisted');

      // Exactly at the previous end is allowed (back-to-back breaks).
      const second = await breaksSvc.startBreak({
        models: db, user: emp.user, type: 'personal', now: new Date('2026-05-04T10:30:00Z'),
      });
      assert.ok(second.id);
      await breaksSvc.stopBreak({ models: db, user: emp.user, now: new Date('2026-05-04T10:45:00Z') });

      // 09:00-11:00 session with 30 + 15 minutes of breaks: 60 minutes computed,
      // and each minute of break is deducted only once.
      const all = await db.TimeBreak.findAll({ where: { timeEntryId: entry.id } });
      const summary = compute.summarize({
        startedAt: entry.startedAt,
        endedAt: new Date('2026-05-04T11:00:00Z'),
        breaks: all,
        now: new Date('2026-05-04T11:00:00Z'),
      });
      assert.strictEqual(summary.breakMinutes, 45, 'total break time is not double counted');
      assert.strictEqual(summary.computedMinutes, 75, '120 elapsed - 45 breaks');
    });
  });

  describe('F03 — saved policies render as checked', () => {
    it('renders checked boxes for the saved policy and keeps them on re-save', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);

      await postForm(ag, '/settings/breaks/', { counts_regular: '1', counts_justified: '1' });

      const page = await ag.get('/settings/breaks/');
      assert.strictEqual(page.status, 200);

      const checked = (page.text.match(/name="counts_[a-z]+" value="1"\s+checked="checked"/g) || []);
      assert.strictEqual(checked.length, 2, 'exactly the two saved types are checked');
      assert.ok(/name="counts_regular"[^>]*checked/.test(page.text), 'regular is checked');
      assert.ok(/name="counts_justified"[^>]*checked/.test(page.text), 'justified is checked');
      assert.ok(!/name="counts_personal"[^>]*checked/.test(page.text), 'personal is not checked');

      // Re-saving the rendered form must not silently disable the policy.
      const res = await postForm(ag, '/settings/breaks/', { counts_regular: '1', counts_justified: '1' });
      assert.ok([302, 303].includes(res.status));
      assert.deepStrictEqual(await breaksSvc.getPolicy(db, user.companyId),
        { regular: true, personal: false, justified: true });
    });
  });

  describe('F04 — the daily comparison covers the whole local day', () => {
    it('adds every session of the day instead of showing only the open one', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      await db.Company.update({ timezone: 'Europe/Madrid' }, { where: { id: user.companyId } });

      const day = moment.utc().tz('Europe/Madrid').format('YYYY-MM-DD');
      const weekday = localWeekday('Europe/Madrid');
      await seedWeek({
        companyId: user.companyId, scopeType: 'company', scopeId: user.companyId,
        days: [{ weekday, start: '09:00', end: '17:00' }],
      });

      // Morning session 09:00-12:00 local, already closed.
      const tzDay = (hhmm) => moment.tz(`${day} ${hhmm}`, 'YYYY-MM-DD HH:mm', 'Europe/Madrid').toDate();
      await clock.startEntry({ models: db, user: emp.user, modality: 'office', now: tzDay('09:00') });
      await clock.stopEntry({ models: db, user: emp.user, now: tzDay('12:00') });

      // Second session opened now (afternoon).
      const empAg = agent();
      await login(empAg, emp.email, emp.password);
      await postForm(empAg, '/time/start', { modality: 'office' });

      const page = await empAg.get('/time/');
      assert.strictEqual(page.status, 200);

      const expected = compute.expectedMinutesForDay({
        day, startTime: '09:00', endTime: '17:00', timezone: 'Europe/Madrid', moment,
      });
      assert.strictEqual(expected, 480);

      // The day total must include the closed morning session (>= 180 minutes),
      // not only the freshly opened one.
      const match = page.text.match(/computed:\s*<strong>([^<]+)<\/strong>/);
      assert.ok(match, 'computed value is rendered in the comparison panel');
      const computedLabel = match[1].trim();
      const hours = computedLabel.match(/^(\d+)\s*h/);
      const minutes = computedLabel.match(/(\d+)\s*min/);
      const totalMinutes = (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
      assert.ok(totalMinutes >= 180, 'the closed morning session is included (got ' + computedLabel + ')');
    });

    it('clips a session that crosses local midnight', () => {
      // Local day 2026-05-04 in Madrid = 2026-05-03T22:00Z .. 2026-05-04T22:00Z.
      const windowStart = moment.tz('2026-05-04', 'Europe/Madrid').startOf('day').toDate();
      // Half-open window: next local midnight.
      const windowEnd = moment.tz('2026-05-04', 'Europe/Madrid').startOf('day').add(1, 'day').toDate();

      const totals = compute.computedWithinWindow({
        windowStart,
        windowEnd,
        now: new Date('2026-05-05T07:00:00Z'),
        entries: [{
          startedAt: new Date('2026-05-04T20:00:00Z'),
          endedAt: new Date('2026-05-05T07:00:00Z'),
          breaks: [],
        }],
      });

      // Only 20:00Z-22:00Z belongs to 4 May local (2 h), not the whole 11 h.
      assert.strictEqual(totals.elapsedMinutes, 120, 'clipped to the local day');
      assert.strictEqual(totals.computedMinutes, 120);
    });

    it('adds several sessions and subtracts each break once', () => {
      const windowStart = new Date('2026-05-04T00:00:00Z');
      const windowEnd = new Date('2026-05-04T23:59:59Z');
      const totals = compute.computedWithinWindow({
        windowStart, windowEnd, now: new Date('2026-05-04T23:00:00Z'),
        entries: [
          { startedAt: new Date('2026-05-04T09:00:00Z'), endedAt: new Date('2026-05-04T12:00:00Z'), breaks: [] },
          {
            startedAt: new Date('2026-05-04T13:00:00Z'),
            endedAt: new Date('2026-05-04T17:00:00Z'),
            breaks: [{ startedAt: new Date('2026-05-04T14:00:00Z'), endedAt: new Date('2026-05-04T14:30:00Z'), countsAsWork: false }],
          },
        ],
      });
      assert.strictEqual(totals.elapsedMinutes, 420, '3 h + 4 h');
      assert.strictEqual(totals.computedMinutes, 390, 'minus the 30 min break');
    });
  });

  describe('F05 — civil dates are compared as civil dates', () => {
    it('detects a bank holiday stored at 00:00 UTC in a zone behind UTC', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      await db.Company.update({ timezone: 'America/New_York' }, { where: { id: user.companyId } });

      const day = moment.utc().tz('America/New_York').format('YYYY-MM-DD');
      const weekday = localWeekday('America/New_York');
      await seedWeek({
        companyId: user.companyId, scopeType: 'company', scopeId: user.companyId,
        days: [{ weekday, start: '09:00', end: '17:00' }],
      });

      // Civil date stored the way the project stores holiday dates.
      await db.BankHoliday.create({
        companyId: user.companyId,
        name: 'Civil date holiday',
        date: moment.utc(day + ' 00:00:00').toDate(),
      });

      const empAg = agent();
      await login(empAg, emp.email, emp.password);
      await postForm(empAg, '/time/start', { modality: 'office' });

      const page = await empAg.get('/time/');
      assert.strictEqual(page.status, 200);
      assert.ok(/Difference not available: company bank holiday/.test(page.text),
        'the holiday must be detected even though the local day is offset from UTC');
      assert.ok(!/−\d/.test(page.text), 'no misleading deficit is shown');
    });

    it('detects an approved absence stored as a civil date in a zone behind UTC', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      const emp = await addEmployee(ag, user.companyId);
      await db.Company.update({ timezone: 'America/New_York' }, { where: { id: user.companyId } });

      const day = moment.utc().tz('America/New_York').format('YYYY-MM-DD');
      const weekday = localWeekday('America/New_York');
      await seedWeek({
        companyId: user.companyId, scopeType: 'company', scopeId: user.companyId,
        days: [{ weekday, start: '09:00', end: '17:00' }],
      });

      const empAg = agent();
      await login(empAg, emp.email, emp.password);
      const lt = await holidayType(user.companyId);
      const leave = await bookLeave(empAg, { leaveTypeId: lt.id, userId: emp.user.id, from: day, to: day });
      assert.ok(leave, 'absence created');
      await db.Leave.update({ status: db.Leave.status_approved() }, { where: { id: leave.id } });

      await postForm(empAg, '/time/start', { modality: 'office' });
      const page = await empAg.get('/time/');
      assert.ok(/Difference not available: approved absence/.test(page.text));
    });
  });

  describe('F06 — the migration is atomic', () => {
    it('leaves no partial schema when a statement in the middle fails', async () => {
      const migration = require('../../migrations/20260105000000-time-breaks');

      // Clean slate for the two tables (the suite already migrated them).
      const qi = db.sequelize.getQueryInterface();
      await qi.dropTable('time_breaks');
      await qi.dropTable('break_policies');

      // Fail on the very first index creation, after both tables exist.
      const realAddIndex = qi.addIndex;
      qi.addIndex = async function (table) {
        if (table === 'break_policies') throw new Error('simulated failure while creating an index');
        return realAddIndex.apply(this, arguments);
      };

      try {
        await assert.rejects(
          () => migration.up(qi, Sequelize),
          /simulated failure/
        );
      } finally {
        qi.addIndex = realAddIndex;
      }

      // Rolled back: neither table survived the failed attempt.
      const tables = await qi.showAllTables();
      const names = tables.map((t) => (typeof t === 'string' ? t : (t.tableName || t.name)));
      assert.ok(!names.includes('break_policies'), 'break_policies rolled back');
      assert.ok(!names.includes('time_breaks'), 'time_breaks rolled back');

      // And the retry succeeds cleanly (no "already exists").
      await migration.up(qi, Sequelize);
      const after = (await qi.showAllTables()).map((t) => (typeof t === 'string' ? t : (t.tableName || t.name)));
      assert.ok(after.includes('break_policies'));
      assert.ok(after.includes('time_breaks'));
    });
  });
});
