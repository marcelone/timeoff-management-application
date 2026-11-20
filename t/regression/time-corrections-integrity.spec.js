'use strict';

const assert = require('assert');
const moment = require('moment-timezone');
const H = require('./helper');
const { db } = H;
const corrections = require('../../lib/modules/time/corrections');
const clock = require('../../lib/modules/time/clock');
const breaks = require('../../lib/modules/time/breaks');
const CompanyRemover = require('../../lib/model/company/remover');

async function setup() {
  const agent = H.agent();
  const { user: admin } = await H.registerAdmin(agent);
  const { user } = await H.addEmployee(agent, admin.companyId);
  return { agent, admin, user };
}
async function entry(user, start, end) {
  const row = await clock.startEntry({ models: db, user, modality: 'office', now: new Date(start) });
  if (end) await clock.stopEntry({ models: db, user, now: new Date(end) });
  return row;
}
async function request(user, row, type, date, time) {
  return (await corrections.createRequest({ models: db, actor: user, entryId: row.id, type,
    timezone: 'UTC', input: { date, time, reason: 'Integrity regression' } })).correction;
}

describe('time corrections — integrity regressions', function () {
  it('keeps all clock history if deleting a company fails after deleting events', async () => {
    const { admin, user } = await setup();
    const row = await entry(user, '2026-01-01T09:00:00Z', '2026-01-01T17:00:00Z');
    const c = await request(user, row, 'entry_start', '2026-01-01', '08:00');
    const company = await db.Company.findByPk(user.companyId);
    const originalDestroy = db.TimeEntry.destroy;
    db.TimeEntry.destroy = async () => { throw new Error('injected delete failure'); };
    try {
      await assert.rejects(CompanyRemover.promiseToRemove({ company, byUser: admin, confirmName: company.name }), /injected delete failure/);
    } finally { db.TimeEntry.destroy = originalDestroy; }
    assert.ok(await db.Company.findByPk(company.id));
    assert.ok(await db.TimeEntry.findByPk(row.id));
    assert.ok(await db.TimeCorrection.findByPk(c.id));
    assert.strictEqual(await db.TimeEntryEvent.count({ where: { timeEntryId: row.id } }), 2);
  });

  it('deletes a company with configured break policy atomically', async () => {
    const { admin, user } = await setup();
    await breaks.setPolicy(db, user.companyId, { regular: true });
    await entry(user, '2026-01-02T09:00:00Z', '2026-01-02T17:00:00Z');
    const company = await db.Company.findByPk(user.companyId);
    await CompanyRemover.promiseToRemove({ company, byUser: admin, confirmName: company.name });
    assert.strictEqual(await db.Company.findByPk(company.id), null);
    assert.strictEqual(await db.BreakPolicy.count({ where: { companyId: company.id } }), 0);
  });

  it('uses the declared next-day civil time across both DST changes', async () => {
    const { user } = await setup();
    await corrections.setPolicy({ models: db, companyId: user.companyId, mode: 'self_service' });
    for (const [date, expectedDay, minutes] of [['2026-03-28', '2026-03-29', 420], ['2026-10-24', '2026-10-25', 540]]) {
      const { correction } = await corrections.createRequest({ models: db, actor: user, type: 'missing_entry', timezone: 'Europe/Madrid',
        input: { date, time: '22:00', end_time: '06:00', reason: 'Overnight shift' } });
      const row = await db.TimeEntry.findByPk(correction.timeEntryId);
      assert.strictEqual(moment(row.endedAt).tz('Europe/Madrid').format('YYYY-MM-DD HH:mm'), expectedDay + ' 06:00');
      assert.strictEqual((row.endedAt - row.startedAt) / 60000, minutes);
    }
    await assert.rejects(corrections.createRequest({ models: db, actor: user, type: 'missing_entry', timezone: 'Europe/Madrid',
      input: { date: '2026-03-28', time: '22:00', end_time: '02:30', reason: 'DST gap' } }), /not a valid date and time/);
    await assert.rejects(corrections.createRequest({ models: db, actor: user, type: 'missing_entry', timezone: 'Europe/Madrid',
      input: { date: '2026-03-26', time: '09:00', end_time: '09:00', reason: 'Zero duration' } }), /must end after it starts/);
  });

  it('accepts a forgotten break that crosses midnight inside a session', async () => {
    const { user } = await setup();
    await corrections.setPolicy({ models: db, companyId: user.companyId, mode: 'self_service' });
    const row = await entry(user, '2026-02-01T22:00:00Z', '2026-02-02T06:00:00Z');
    const result = await corrections.createRequest({ models: db, actor: user, type: 'break_missing', entryId: row.id, timezone: 'UTC',
      input: { date: '2026-02-01', time: '23:50', end_time: '00:10', break_type: 'regular', reason: 'Forgot break' } });
    assert.strictEqual(result.correction.status, 'applied');
    const brk = await db.TimeBreak.findOne({ where: { timeEntryId: row.id } });
    assert.strictEqual((brk.endedAt - brk.startedAt) / 60000, 20);
  });

  it('rejects a stale administrator instance after its role is revoked', async () => {
    const { admin } = await setup();
    const row = await entry(admin, '2026-01-03T09:00:00Z', '2026-01-03T17:00:00Z');
    const c = await request(admin, row, 'entry_start', '2026-01-03', '08:00');
    await db.User.update({ admin: false, role: 'employee' }, { where: { id: admin.id } });
    assert.strictEqual(await corrections.canResolve({ models: db, actor: admin, correction: c }), false);
    await assert.rejects(corrections.resolveRequest({ models: db, actor: admin, correctionId: c.id, decision: 'approve' }), /cannot resolve your own/i);
    assert.strictEqual((await c.reload()).status, 'pending');
    assert.strictEqual((await row.reload()).startedAt.toISOString(), '2026-01-03T09:00:00.000Z');
  });

  it('rejects unknown resolution decisions instead of treating them as approval', async () => {
    const { admin, user } = await setup();
    const row = await entry(user, '2026-01-06T09:00:00Z', '2026-01-06T17:00:00Z');
    const c = await request(user, row, 'entry_start', '2026-01-06', '08:00');
    await assert.rejects(corrections.resolveRequest({ models: db, actor: admin, correctionId: c.id, decision: 'unexpected' }), /Unknown correction decision/);
    assert.strictEqual((await c.reload()).status, 'pending');
  });

  it('checks the current supervisor relationship when resolving', async () => {
    const { agent, admin, user } = await setup();
    const supervisor = (await H.addEmployee(agent, admin.companyId)).user;
    const dept = await db.Department.findByPk(user.DepartmentId);
    await dept.update({ bossId: supervisor.id });
    const row = await entry(user, '2026-01-08T09:00:00Z', '2026-01-08T17:00:00Z');
    const c = await request(user, row, 'entry_start', '2026-01-08', '08:00');
    assert.strictEqual(await corrections.canResolve({ models: db, actor: supervisor, correction: c }), true);
    await dept.update({ bossId: null });
    await assert.rejects(corrections.resolveRequest({ models: db, actor: supervisor, correctionId: c.id, decision: 'approve' }), /not allowed/);
    assert.strictEqual((await c.reload()).status, 'pending');
  });

  it('refuses migration rollback that would erase correction or self-approval history', async () => {
    const { admin } = await setup();
    const row = await entry(admin, '2026-01-05T09:00:00Z', '2026-01-05T17:00:00Z');
    const c = await request(admin, row, 'entry_start', '2026-01-05', '08:00');
    await corrections.resolveRequest({ models: db, actor: admin, correctionId: c.id, decision: 'approve' });
    const qi = db.sequelize.getQueryInterface();
    await assert.rejects(require('../../migrations/20260107000000-time-corrections-self-approval').down(qi), /self-approval history exists/);
    await assert.rejects(require('../../migrations/20260106000000-time-corrections').down(qi), /correction history exists/);
    assert.strictEqual((await c.reload()).selfApproved, true);
    assert.strictEqual(await db.TimeEntryEvent.count({ where: { timeEntryId: row.id, type: 'correction' } }), 1);
  });

  it('serializes corrections to different sessions before validating overlap', async () => {
    const { admin, user } = await setup();
    const first = await entry(user, '2026-01-04T09:00:00Z', '2026-01-04T12:00:00Z');
    const second = await entry(user, '2026-01-04T14:00:00Z', '2026-01-04T17:00:00Z');
    const a = await request(user, first, 'entry_end', '2026-01-04', '13:30');
    const b = await request(user, second, 'entry_start', '2026-01-04', '13:00');
    const results = await Promise.allSettled([a, b].map(c => corrections.resolveRequest({ models: db, actor: admin, correctionId: c.id, decision: 'approve' })));
    await first.reload(); await second.reload();
    assert.ok(first.endedAt <= second.startedAt, 'sessions must not overlap');
    assert.ok(results.some(r => r.status === 'fulfilled' && r.value.status === 'applied'));
    if (db.sequelize.getDialect() === 'postgres') assert.deepStrictEqual(results.map(r => r.value.status).sort(), ['applied', 'conflict']);
  });

  it('applies simultaneous self-service declarations without a lock upgrade deadlock', async function () {
    if (db.sequelize.getDialect() !== 'postgres') this.skip();
    const { user } = await setup();
    await corrections.setPolicy({ models: db, companyId: user.companyId, mode: 'self_service' });
    const results = await Promise.all(['2026-02-03', '2026-02-04'].map(date => corrections.createRequest({
      models: db, actor: user, type: 'missing_entry', timezone: 'UTC',
      input: { date, time: '09:00', end_time: '17:00', reason: 'Forgotten shift' },
    })));
    assert.deepStrictEqual(results.map(r => r.correction.status), ['applied', 'applied']);
    assert.strictEqual(await db.TimeEntry.count({ where: { userId: user.id } }), 2);
  });

  it('rechecks a break start after acquiring its session lock', async function () {
    if (db.sequelize.getDialect() !== 'postgres') this.skip();
    const { admin, user } = await setup();
    const row = await entry(user, '2026-01-07T09:00:00Z');
    const brk = await breaks.startBreak({ models: db, user, type: 'regular', now: new Date('2026-01-07T10:00:00Z') });
    const c = (await corrections.createRequest({ models: db, actor: user, type: 'break_start', breakId: brk.id,
      timezone: 'UTC', input: { date: '2026-01-07', time: '11:00', reason: 'Fix break' } })).correction;
    let resume, found;
    const stopped = new Promise(resolve => { found = resolve; });
    const proceed = new Promise(resolve => { resume = resolve; });
    const originalFind = db.TimeBreak.findOne;
    let paused = false;
    db.TimeBreak.findOne = async function (options) {
      const result = await originalFind.call(this, options);
      if (!paused && result && result.id === brk.id && options.where.endedAt === null) {
        paused = true; found(); await proceed;
      }
      return result;
    };
    const stopping = breaks.stopBreak({ models: db, user, now: new Date('2026-01-07T10:30:00Z') });
    try {
      await stopped;
      await corrections.resolveRequest({ models: db, actor: admin, correctionId: c.id, decision: 'approve' });
    } finally {
      resume();
      db.TimeBreak.findOne = originalFind;
    }
    await assert.rejects(stopping, err => err.code === 'INVALID_END');
    assert.strictEqual((await brk.reload()).endedAt, null);
    assert.ok(row);
  });
});
