'use strict';

/*
 * Time tracking — block 3: corrections of recorded sessions and approvals.
 *
 * Covers the 35 required checks of the block-3 specification:
 *   1  direct correction in self-service mode
 *   2  pending request in approval_required mode
 *   3  approval
 *   4  rejection with a reason
 *   5  double approval attempt
 *   6  concurrent approval and rejection
 *   7  supervisor without permissions
 *   8  supervisor of another department
 *   9  supervisor of another company
 *   10 improper self-approval
 *   11 authorised owner/admin
 *   12 corrected clock-in
 *   13 corrected clock-out
 *   14 forgotten clock-out
 *   15 completely forgotten session
 *   16 forgotten break
 *   17 corrected break start and end
 *   18 changed break type
 *   19 changed modality
 *   20 conflict with a modified session
 *   21 two incompatible corrections
 *   22 overlap between sessions
 *   23 overlap between breaks
 *   24 correction while a break is active
 *   25 computation after a correction
 *   26 computation untouched while the request is pending
 *   27 preservation of the original events
 *   28 policy snapshot
 *   29 timezone and DST
 *   30 CSRF (including multipart)
 *   31 manipulation of identifiers and times
 *   32 database errors and rollback
 *   33 PostgreSQL migrations
 *   34 SQLite migrations
 *   35 compatibility with blocks 1 and 2
 *
 * Cases 33 (PostgreSQL) and part of 6 (real concurrency) are verified against an
 * isolated PostgreSQL instance in a separate run; the logic itself is covered
 * here so a plain `npm test` also proves it.
 */

const assert = require('assert');
const moment = require('moment-timezone');
const H = require('./helper');
const { agent, db, postForm, registerAdmin, addEmployee, login } = H;

const corrections = require('../../lib/modules/time/corrections');
const compute = require('../../lib/modules/time/compute');
const clockSvc = require('../../lib/modules/time/clock');
const breaksSvc = require('../../lib/modules/time/breaks');

const TZ = 'Europe/Madrid';

/** Local date (in the effective timezone) N days ago. */
function localDate(daysAgo) {
  return moment.utc().subtract(daysAgo, 'days').format('YYYY-MM-DD');
}

/** Instant of a local wall-clock time, N days ago, in the effective timezone. */
function localAt(daysAgo, hhmm) {
  return moment.tz(`${localDate(daysAgo)} ${hhmm}`, 'YYYY-MM-DD HH:mm', TZ).toDate();
}

/** A session with its original events, like the clock would have created it. */
async function seedSession({ companyId, userId, startedAt, endedAt, modality = 'office' }) {
  const entry = await db.TimeEntry.create({
    companyId,
    userId,
    modality,
    status: endedAt ? 'closed' : 'open',
    source: 'direct',
    version: 1,
    startedAt,
    endedAt: endedAt || null,
  });
  await db.TimeEntryEvent.create({
    companyId, userId, timeEntryId: entry.id, type: 'in',
    occurredAt: startedAt, source: 'direct', modality,
  });
  if (endedAt) {
    await db.TimeEntryEvent.create({
      companyId, userId, timeEntryId: entry.id, type: 'out',
      occurredAt: endedAt, source: 'direct', modality,
    });
  }
  return entry;
}

async function seedBreak({ companyId, userId, entry, type = 'regular', countsAsWork = false, startedAt, endedAt }) {
  const brk = await db.TimeBreak.create({
    companyId, userId, timeEntryId: entry.id, type, countsAsWork,
    startedAt, endedAt: endedAt || null,
  });
  await db.TimeEntryEvent.create({
    companyId, userId, timeEntryId: entry.id, type: 'break_start',
    occurredAt: startedAt, source: 'direct', modality: entry.modality,
  });
  if (endedAt) {
    await db.TimeEntryEvent.create({
      companyId, userId, timeEntryId: entry.id, type: 'break_end',
      occurredAt: endedAt, source: 'direct', modality: entry.modality,
    });
  }
  return brk;
}

/**
 * A company with an admin, a supervisor (boss of the department) and an
 * employee. Both agents are logged in.
 */
async function setupCompany(opts = {}) {
  const adminAg = agent();
  const { user: admin } = await registerAdmin(adminAg, opts.admin || {});
  const companyId = admin.companyId;
  const dept = await db.Department.findOne({ where: { companyId } });

  const sup = await addEmployee(adminAg, companyId, { name: 'Sup', lastname: 'Ervisor' });
  const emp = await addEmployee(adminAg, companyId, { name: 'Emp', lastname: 'Loyee' });

  if (opts.supervisor !== false) {
    dept.bossId = sup.user.id;
    await dept.save();
  }

  const supAg = agent();
  await login(supAg, sup.email, sup.password);
  const empAg = agent();
  await login(empAg, emp.email, emp.password);

  return { adminAg, admin, companyId, dept, sup, emp, supAg, empAg };
}

/** An employee in another department (not supervised by our supervisor). */
async function addForeignEmployee(companyId) {
  const otherDept = await db.Department.create({ name: 'Other', companyId });
  const other = await db.User.create({
    email: `other-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
    password: 'x', name: 'Other', lastname: 'Dept',
    companyId, DepartmentId: otherDept.id, admin: false, activated: true,
    start_date: '2026-01-01',
  });
  return { otherDept, other };
}

describe('time tracking — block 3 (corrections & approvals)', function () {

  // The whole suite shares one database. The correction requests reference the
  // work sessions and the breaks, so they are removed at the end of this file:
  // the block-2 migration test drops the break table and would otherwise find
  // requests still pointing at it.
  after(async () => {
    await db.TimeCorrection.destroy({ where: {} });
    await db.Audit.destroy({ where: { entityType: 'TIME_CORRECTION' } });
  });

  describe('schema and company policy', () => {
    it('creates the correction tables and keeps the block-1/block-2 tables', async () => {
      const tables = await db.sequelize.getQueryInterface().showAllTables();
      const names = tables.map((t) => (typeof t === 'string' ? t : (t.tableName || t.name)));
      ['time_corrections', 'time_correction_policies', 'time_entries', 'time_entry_events',
        'time_breaks', 'work_schedule_days'].forEach((t) => {
        assert.ok(names.includes(t), 'missing table ' + t);
      });
    });

    it('defaults to approval_required and lets the owner change it', async () => {
      const s = await setupCompany();

      const mode = await corrections.getPolicy({ models: db, companyId: s.companyId });
      assert.strictEqual(mode, 'approval_required', 'the prudent default');

      await corrections.setPolicy({ models: db, companyId: s.companyId, mode: 'self_service' });
      assert.strictEqual(
        await corrections.getPolicy({ models: db, companyId: s.companyId }), 'self_service'
      );

      // The settings page is reachable by the owner and by nobody else.
      const res = await s.adminAg.get('/settings/corrections/');
      assert.strictEqual(res.status, 200);
      assert.ok(/self_service|Self-service/i.test(res.text), 'the policy is rendered');

      const supRes = await s.supAg.get('/settings/corrections/');
      assert.strictEqual(supRes.status, 303, 'a supervisor cannot open the company policy');
    });

    it('records the correction policy through the real settings route', async () => {
      const s = await setupCompany();
      const res = await postForm(s.adminAg, '/settings/corrections/', { mode: 'self_service' });
      assert.ok([302, 303].includes(res.status));
      assert.strictEqual(
        await corrections.getPolicy({ models: db, companyId: s.companyId }), 'self_service'
      );
    });

    it('refuses an unknown policy', async () => {
      const s = await setupCompany();
      await assert.rejects(
        () => corrections.setPolicy({ models: db, companyId: s.companyId, mode: 'whatever' }),
        /Unknown correction policy/i
      );
    });
  });

  describe('requesting a correction', () => {
    it('self-service: the correction is applied immediately and the original is kept', async () => {
      const s = await setupCompany();
      await corrections.setPolicy({ models: db, companyId: s.companyId, mode: 'self_service' });

      const entry = await seedSession({
        companyId: s.companyId, userId: s.emp.user.id,
        startedAt: localAt(3, '09:17'), endedAt: localAt(3, '17:03'),
      });

      const res = await postForm(s.empAg, '/time/corrections/', {
        type: 'entry_start',
        target: 'entry-' + entry.id,
        date: localDate(3),
        time: '09:00',
        reason: 'I forgot to clock in when I arrived.',
      });
      assert.ok([302, 303].includes(res.status));

      const correction = await db.TimeCorrection.findOne({ where: { userId: s.emp.user.id } });
      assert.ok(correction, 'the request is persisted');
      assert.strictEqual(correction.status, 'applied');
      assert.strictEqual(correction.policy, 'self_service');
      assert.strictEqual(String(correction.resolvedById), String(s.emp.user.id));

      // The effective value changed...
      const fresh = await db.TimeEntry.findByPk(entry.id);
      assert.strictEqual(
        moment.utc(fresh.startedAt).tz(TZ).format('HH:mm'), '09:00', 'effective clock-in corrected'
      );

      // ...but the original event is still there.
      const events = await db.TimeEntryEvent.findAll({
        where: { timeEntryId: entry.id }, order: [['id', 'ASC']],
      });
      const inEvent = events.find((e) => e.type === 'in');
      assert.strictEqual(
        moment.utc(inEvent.occurredAt).tz(TZ).format('HH:mm'), '09:17', 'the original clock-in survives'
      );
      const correctionEvent = events.find((e) => e.type === 'correction');
      assert.ok(correctionEvent, 'a correction event was appended');
      assert.strictEqual(String(correctionEvent.correctionId), String(correction.id));
      assert.strictEqual(correctionEvent.source, 'corrected');
    });

    it('approval_required: the request stays pending and nothing changes', async () => {
      const s = await setupCompany();
      const entry = await seedSession({
        companyId: s.companyId, userId: s.emp.user.id,
        startedAt: localAt(3, '09:17'), endedAt: localAt(3, '17:03'),
      });

      const res = await postForm(s.empAg, '/time/corrections/', {
        type: 'entry_start',
        target: 'entry-' + entry.id,
        date: localDate(3),
        time: '09:00',
        reason: 'I forgot to clock in when I arrived.',
      });
      assert.ok([302, 303].includes(res.status));

      const correction = await db.TimeCorrection.findOne({ where: { userId: s.emp.user.id } });
      assert.strictEqual(correction.status, 'pending');
      assert.strictEqual(correction.policy, 'approval_required');
      assert.strictEqual(correction.resolvedById, null);

      const fresh = await db.TimeEntry.findByPk(entry.id);
      assert.strictEqual(
        moment.utc(fresh.startedAt).tz(TZ).format('HH:mm'), '09:17',
        'a pending request does not change the effective record'
      );
      assert.strictEqual(
        await db.TimeEntryEvent.count({ where: { timeEntryId: entry.id, type: 'correction' } }), 0,
        'no correction event while the request is pending'
      );
    });

    it('requires a reason', async () => {
      const s = await setupCompany();
      const entry = await seedSession({
        companyId: s.companyId, userId: s.emp.user.id,
        startedAt: localAt(3, '09:17'), endedAt: localAt(3, '17:03'),
      });

      const res = await postForm(s.empAg, '/time/corrections/', {
        type: 'entry_start',
        target: 'entry-' + entry.id,
        date: localDate(3),
        time: '09:00',
        reason: '',
      });
      assert.ok([302, 303].includes(res.status));

      assert.strictEqual(
        await db.TimeCorrection.count({ where: { userId: s.emp.user.id } }), 0,
        'no request without a reason'
      );
    });

    it('refuses a second pending request for the same target', async () => {
      const s = await setupCompany();
      const entry = await seedSession({
        companyId: s.companyId, userId: s.emp.user.id,
        startedAt: localAt(3, '09:17'), endedAt: localAt(3, '17:03'),
      });

      const body = {
        type: 'entry_start', target: 'entry-' + entry.id,
        date: localDate(3), time: '09:00', reason: 'forgot to clock in',
      };
      await postForm(s.empAg, '/time/corrections/', body);
      const res = await postForm(s.empAg, '/time/corrections/', body);

      assert.ok([302, 303].includes(res.status));
      assert.strictEqual(
        await db.TimeCorrection.count({ where: { userId: s.emp.user.id, status: 'pending' } }), 1,
        'the database refuses two pending requests for the same target'
      );
    });

    it('refuses to correct a session of another employee', async () => {
      const s = await setupCompany();
      const entry = await seedSession({
        companyId: s.companyId, userId: s.sup.user.id,
        startedAt: localAt(3, '09:17'), endedAt: localAt(3, '17:03'),
      });

      const res = await postForm(s.empAg, '/time/corrections/', {
        type: 'entry_start',
        target: 'entry-' + entry.id,
        date: localDate(3),
        time: '09:00',
        reason: 'not my session',
      });
      assert.ok([302, 303].includes(res.status));
      assert.strictEqual(
        await db.TimeCorrection.count({ where: { userId: s.emp.user.id } }), 0,
        'no request created for a foreign session'
      );
    });

    it('shows the correction screens to the employee', async () => {
      const s = await setupCompany();
      const list = await s.empAg.get('/time/corrections/');
      assert.strictEqual(list.status, 200);
      assert.ok(/My corrections/i.test(list.text));

      const types = await s.empAg.get('/time/corrections/new/');
      assert.strictEqual(types.status, 200);
      assert.ok(/Clock-in time/i.test(types.text));

      const target = await s.empAg.get('/time/corrections/new/entry_start/');
      assert.strictEqual(target.status, 200);

      const form = await s.empAg.get('/time/corrections/new/missing_entry/');
      assert.strictEqual(form.status, 200);
      assert.ok(/reason/i.test(form.text));
    });
  });

  describe('approving and rejecting', () => {
    async function pendingRequest(s) {
      const entry = await seedSession({
        companyId: s.companyId, userId: s.emp.user.id,
        startedAt: localAt(3, '09:17'), endedAt: localAt(3, '17:03'),
      });
      await postForm(s.empAg, '/time/corrections/', {
        type: 'entry_start', target: 'entry-' + entry.id,
        date: localDate(3), time: '09:00', reason: 'forgot to clock in',
      });
      return { entry, correction: await db.TimeCorrection.findOne({ where: { userId: s.emp.user.id } }) };
    }

    it('the supervisor approves and the correction is applied', async () => {
      const s = await setupCompany();
      const { entry, correction } = await pendingRequest(s);

      const res = await postForm(s.supAg, '/time/approvals/' + correction.id + '/approve/', {});
      assert.ok([302, 303].includes(res.status));

      const fresh = await db.TimeCorrection.findByPk(correction.id);
      assert.strictEqual(fresh.status, 'applied');
      assert.strictEqual(String(fresh.resolvedById), String(s.sup.user.id));
      assert.ok(fresh.resolvedAt);

      const entry2 = await db.TimeEntry.findByPk(entry.id);
      assert.strictEqual(
        moment.utc(entry2.startedAt).tz(TZ).format('HH:mm'), '09:00', 'the correction was applied'
      );
    });

    it('the supervisor rejects with a reason', async () => {
      const s = await setupCompany();
      const { entry, correction } = await pendingRequest(s);

      const res = await postForm(s.supAg, '/time/approvals/' + correction.id + '/reject/', {
        reason: 'That day was already corrected by the manager.',
      });
      assert.ok([302, 303].includes(res.status));

      const fresh = await db.TimeCorrection.findByPk(correction.id);
      assert.strictEqual(fresh.status, 'rejected');
      assert.strictEqual(fresh.rejectionReason, 'That day was already corrected by the manager.');

      const entry2 = await db.TimeEntry.findByPk(entry.id);
      assert.strictEqual(
        moment.utc(entry2.startedAt).tz(TZ).format('HH:mm'), '09:17', 'a rejection changes nothing'
      );
    });

    it('a rejection without an explanation is refused', async () => {
      const s = await setupCompany();
      const { correction } = await pendingRequest(s);

      const res = await postForm(s.supAg, '/time/approvals/' + correction.id + '/reject/', { reason: '  ' });
      assert.ok([302, 303].includes(res.status));

      const fresh = await db.TimeCorrection.findByPk(correction.id);
      assert.strictEqual(fresh.status, 'pending', 'the request is still pending');
    });

    it('a second approval does not apply the correction twice', async () => {
      const s = await setupCompany();
      const { correction } = await pendingRequest(s);

      await postForm(s.supAg, '/time/approvals/' + correction.id + '/approve/', {});
      const second = await postForm(s.supAg, '/time/approvals/' + correction.id + '/approve/', {});
      assert.ok([302, 303].includes(second.status));

      const fresh = await db.TimeCorrection.findByPk(correction.id);
      assert.strictEqual(fresh.status, 'applied');
      assert.strictEqual(
        await db.TimeEntryEvent.count({ where: { timeEntryId: correction.timeEntryId, type: 'correction' } }),
        1, 'exactly one correction event'
      );
    });

    it('a request cannot end up approved and rejected at the same time', async () => {
      const s = await setupCompany();
      const { correction } = await pendingRequest(s);

      await postForm(s.supAg, '/time/approvals/' + correction.id + '/approve/', {});
      const rej = await postForm(s.supAg, '/time/approvals/' + correction.id + '/reject/', {
        reason: 'too late',
      });
      assert.ok([302, 303].includes(rej.status));

      const fresh = await db.TimeCorrection.findByPk(correction.id);
      assert.strictEqual(fresh.status, 'applied', 'the second resolution was ignored');
    });

    it('the employee cannot approve their own request', async () => {
      const s = await setupCompany();
      const { correction } = await pendingRequest(s);

      const res = await postForm(s.empAg, '/time/approvals/' + correction.id + '/approve/', {});
      assert.ok([302, 303].includes(res.status));

      const fresh = await db.TimeCorrection.findByPk(correction.id);
      assert.strictEqual(fresh.status, 'pending', 'self-approval is refused');
    });

    it('a supervisor cannot approve a request of another department', async () => {
      const s = await setupCompany();
      const { other } = await addForeignEmployee(s.companyId);

      const entry = await seedSession({
        companyId: s.companyId, userId: other.id,
        startedAt: localAt(3, '09:17'), endedAt: localAt(3, '17:03'),
      });
      const otherUser = await db.User.findByPk(other.id);
      await corrections.createRequest({
        models: db, actor: otherUser, type: 'entry_start',
        entryId: entry.id, input: { date: localDate(3), time: '09:00', reason: 'forgot to clock in' },
        timezone: TZ,
      });
      const correction = await db.TimeCorrection.findOne({ where: { userId: other.id } });

      const res = await postForm(s.supAg, '/time/approvals/' + correction.id + '/approve/', {});
      assert.ok([302, 303].includes(res.status));

      const fresh = await db.TimeCorrection.findByPk(correction.id);
      assert.strictEqual(fresh.status, 'pending', 'another department is out of reach');
    });

    it('a supervisor of another company cannot resolve the request', async () => {
      const s = await setupCompany();
      const { correction } = await pendingRequest(s);

      const otherAdminAg = agent();
      const other = await registerAdmin(otherAdminAg);
      assert.notStrictEqual(other.user.companyId, s.companyId);

      const res = await postForm(otherAdminAg, '/time/approvals/' + correction.id + '/approve/', {});
      assert.ok([302, 303].includes(res.status));

      const fresh = await db.TimeCorrection.findByPk(correction.id);
      assert.strictEqual(fresh.status, 'pending', 'another company is out of reach');
    });

    it('an employee without supervision cannot resolve anything', async () => {
      const s = await setupCompany();
      const { correction } = await pendingRequest(s);

      const plain = await addEmployee(s.adminAg, s.companyId, { name: 'Plain', lastname: 'Employee' });
      const plainAg = agent();
      await login(plainAg, plain.email, plain.password);

      const res = await postForm(plainAg, '/time/approvals/' + correction.id + '/approve/', {});
      assert.ok([302, 303].includes(res.status));

      const fresh = await db.TimeCorrection.findByPk(correction.id);
      assert.strictEqual(fresh.status, 'pending');
    });

    it('the owner/admin resolves a request of the whole company', async () => {
      const s = await setupCompany();
      const { correction } = await pendingRequest(s);

      const res = await postForm(s.adminAg, '/time/approvals/' + correction.id + '/approve/', {});
      assert.ok([302, 303].includes(res.status));

      const fresh = await db.TimeCorrection.findByPk(correction.id);
      assert.strictEqual(fresh.status, 'applied');
      assert.strictEqual(String(fresh.resolvedById), String(s.admin.id));
    });

    it('a DepartmentSupervisor (not the boss) can also resolve', async () => {
      const s = await setupCompany();
      const { correction } = await pendingRequest(s);

      const helper = await addEmployee(s.adminAg, s.companyId, { name: 'Help', lastname: 'Ervisor' });
      await db.DepartmentSupervisor.create({ department_id: s.dept.id, user_id: helper.user.id });

      const helperAg = agent();
      await login(helperAg, helper.email, helper.password);

      const res = await postForm(helperAg, '/time/approvals/' + correction.id + '/approve/', {});
      assert.ok([302, 303].includes(res.status));

      const fresh = await db.TimeCorrection.findByPk(correction.id);
      assert.strictEqual(fresh.status, 'applied');
    });

    it('the owner/admin approves their own request (administrative self-approval)', async () => {
      const s = await setupCompany();
      const entry = await seedSession({
        companyId: s.companyId, userId: s.admin.id,
        startedAt: localAt(3, '09:17'), endedAt: localAt(3, '17:03'),
      });
      const adminUser = await db.User.findByPk(s.admin.id);
      await corrections.createRequest({
        models: db, actor: adminUser, type: 'entry_start',
        entryId: entry.id, input: { date: localDate(3), time: '09:00', reason: 'forgot to clock in' },
        timezone: TZ,
      });
      const correction = await db.TimeCorrection.findOne({ where: { userId: s.admin.id } });

      const res = await postForm(s.adminAg, '/time/approvals/' + correction.id + '/approve/', {});
      assert.ok([302, 303].includes(res.status));

      const fresh = await db.TimeCorrection.findByPk(correction.id);
      assert.strictEqual(fresh.status, 'applied', 'the owner may administratively approve their own request');
      assert.strictEqual(fresh.selfApproved, true, 'the exception is flagged on the request');
      assert.strictEqual(String(fresh.resolvedById), String(s.admin.id));
    });

    it('the supervisor screen lists the pending requests of their employees', async () => {
      const s = await setupCompany();
      await pendingRequest(s);

      const res = await s.supAg.get('/time/approvals/');
      assert.strictEqual(res.status, 200);
      assert.ok(/forgot to clock in/.test(res.text), 'the reason is visible to the supervisor');
      assert.ok(/09:00/.test(res.text), 'the proposed value is visible');
    });
  });

  describe('the correction cases', () => {
    it('corrects a clock-in and recomputes the worked time', async () => {
      const s = await setupCompany();
      await corrections.setPolicy({ models: db, companyId: s.companyId, mode: 'self_service' });

      const entry = await seedSession({
        companyId: s.companyId, userId: s.emp.user.id,
        startedAt: localAt(3, '09:20'), endedAt: localAt(3, '17:00'),
      });

      await postForm(s.empAg, '/time/corrections/', {
        type: 'entry_start', target: 'entry-' + entry.id,
        date: localDate(3), time: '09:00', reason: 'forgot to clock in',
      });

      const fresh = await db.TimeEntry.findByPk(entry.id);
      const totals = compute.summarize({
        startedAt: fresh.startedAt, endedAt: fresh.endedAt, breaks: [],
      });
      assert.strictEqual(totals.computedMinutes, 8 * 60, '8h of computed time');

      // The original 7h40 is still reconstructible from the events.
      const events = await db.TimeEntryEvent.findAll({
        where: { timeEntryId: entry.id }, order: [['id', 'ASC']],
      });
      const inEvent = events.find((e) => e.type === 'in');
      const original = compute.summarize({
        startedAt: inEvent.occurredAt, endedAt: fresh.endedAt, breaks: [],
      });
      assert.strictEqual(original.computedMinutes, 7 * 60 + 40, 'the original is still auditable');
    });

    it('corrects a clock-out of a closed session', async () => {
      const s = await setupCompany();
      await corrections.setPolicy({ models: db, companyId: s.companyId, mode: 'self_service' });

      const entry = await seedSession({
        companyId: s.companyId, userId: s.emp.user.id,
        startedAt: localAt(3, '09:00'), endedAt: localAt(3, '17:00'),
      });

      await postForm(s.empAg, '/time/corrections/', {
        type: 'entry_end', target: 'entry-' + entry.id,
        date: localDate(3), time: '18:00', reason: 'I stayed to finish a report.',
      });

      const fresh = await db.TimeEntry.findByPk(entry.id);
      assert.strictEqual(moment.utc(fresh.endedAt).tz(TZ).format('HH:mm'), '18:00');
      assert.strictEqual(fresh.status, 'closed');
    });

    it('declares a forgotten clock-out of an open session', async () => {
      const s = await setupCompany();
      await corrections.setPolicy({ models: db, companyId: s.companyId, mode: 'self_service' });

      const entry = await seedSession({
        companyId: s.companyId, userId: s.emp.user.id,
        startedAt: localAt(3, '09:00'), endedAt: null,
      });

      await postForm(s.empAg, '/time/corrections/', {
        type: 'entry_end', target: 'entry-' + entry.id,
        date: localDate(3), time: '17:30', reason: 'I forgot to clock out.',
      });

      const fresh = await db.TimeEntry.findByPk(entry.id);
      assert.strictEqual(fresh.status, 'closed');
      assert.strictEqual(moment.utc(fresh.endedAt).tz(TZ).format('HH:mm'), '17:30');

      // The declaration moment is kept apart from the declared time.
      const correction = await db.TimeCorrection.findOne({ where: { userId: s.emp.user.id } });
      const payload = JSON.parse(
        (await db.TimeEntryEvent.findOne({
          where: { timeEntryId: entry.id, type: 'correction' },
        })).payload
      );
      assert.ok(payload.declaredAt, 'the moment of the declaration is recorded');
      assert.notStrictEqual(payload.declaredAt, payload.to);
    });

    it('declares a completely forgotten session', async () => {
      const s = await setupCompany();
      await corrections.setPolicy({ models: db, companyId: s.companyId, mode: 'self_service' });

      await postForm(s.empAg, '/time/corrections/', {
        type: 'missing_entry',
        date: localDate(4), time: '09:00', end_time: '17:00',
        modality: 'office', reason: 'I forgot to clock in and out.',
      });

      const correction = await db.TimeCorrection.findOne({ where: { userId: s.emp.user.id } });
      assert.strictEqual(correction.status, 'applied');
      assert.ok(correction.timeEntryId, 'the declared session was created');

      const entry = await db.TimeEntry.findByPk(correction.timeEntryId);
      assert.strictEqual(entry.source, 'declared', 'it is identified as declared, not clocked');
      assert.strictEqual(entry.status, 'closed');
      assert.strictEqual(moment.utc(entry.startedAt).tz(TZ).format('HH:mm'), '09:00');
      assert.strictEqual(moment.utc(entry.endedAt).tz(TZ).format('HH:mm'), '17:00');

      const events = await db.TimeEntryEvent.findAll({
        where: { timeEntryId: entry.id }, order: [['id', 'ASC']],
      });
      assert.deepStrictEqual(events.map((e) => e.type), ['in', 'out', 'correction']);
      assert.strictEqual(events[0].source, 'declared');
      assert.strictEqual(events[1].source, 'declared');
    });

    it('refuses to declare a session that overlaps another one', async () => {
      const s = await setupCompany();
      await seedSession({
        companyId: s.companyId, userId: s.emp.user.id,
        startedAt: localAt(4, '09:00'), endedAt: localAt(4, '17:00'),
      });

      const res = await postForm(s.empAg, '/time/corrections/', {
        type: 'missing_entry',
        date: localDate(4), time: '12:00', end_time: '15:00',
        modality: 'office', reason: 'duplicate',
      });
      assert.ok([302, 303].includes(res.status));
      assert.strictEqual(
        await db.TimeCorrection.count({ where: { userId: s.emp.user.id } }), 0,
        'the overlapping declaration was refused'
      );
    });

    it('declares a forgotten break', async () => {
      const s = await setupCompany();
      await corrections.setPolicy({ models: db, companyId: s.companyId, mode: 'self_service' });

      const entry = await seedSession({
        companyId: s.companyId, userId: s.emp.user.id,
        startedAt: localAt(3, '09:00'), endedAt: localAt(3, '17:00'),
      });

      await postForm(s.empAg, '/time/corrections/', {
        type: 'break_missing', target: 'entry-' + entry.id,
        date: localDate(3), time: '13:00', end_time: '13:30',
        break_type: 'regular', reason: 'I forgot to start the break.',
      });

      const breaks = await db.TimeBreak.findAll({ where: { timeEntryId: entry.id } });
      assert.strictEqual(breaks.length, 1);
      assert.strictEqual(breaks[0].type, 'regular');
      assert.strictEqual(moment.utc(breaks[0].startedAt).tz(TZ).format('HH:mm'), '13:00');
      assert.strictEqual(moment.utc(breaks[0].endedAt).tz(TZ).format('HH:mm'), '13:30');
      assert.strictEqual(breaks[0].countsAsWork, false, 'the snapshot of the current policy is used');

      const events = await db.TimeEntryEvent.findAll({
        where: { timeEntryId: entry.id }, order: [['id', 'ASC']],
      });
      assert.deepStrictEqual(events.map((e) => e.type), ['in', 'out', 'break_start', 'break_end', 'correction']);
    });

    it('corrects the start and the end of a break', async () => {
      const s = await setupCompany();
      await corrections.setPolicy({ models: db, companyId: s.companyId, mode: 'self_service' });

      const entry = await seedSession({
        companyId: s.companyId, userId: s.emp.user.id,
        startedAt: localAt(3, '09:00'), endedAt: localAt(3, '17:00'),
      });
      const brk = await seedBreak({
        companyId: s.companyId, userId: s.emp.user.id, entry,
        startedAt: localAt(3, '13:00'), endedAt: localAt(3, '13:30'),
      });

      await postForm(s.empAg, '/time/corrections/', {
        type: 'break_start', target: 'break-' + brk.id,
        date: localDate(3), time: '12:45', reason: 'the break started earlier',
      });

      let fresh = await db.TimeBreak.findByPk(brk.id);
      assert.strictEqual(moment.utc(fresh.startedAt).tz(TZ).format('HH:mm'), '12:45');

      await postForm(s.empAg, '/time/corrections/', {
        type: 'break_end', target: 'break-' + brk.id,
        date: localDate(3), time: '13:45', reason: 'the break lasted longer',
      });

      fresh = await db.TimeBreak.findByPk(brk.id);
      assert.strictEqual(moment.utc(fresh.endedAt).tz(TZ).format('HH:mm'), '13:45');
    });

    it('changes the type of a break and preserves its counting criterion', async () => {
      const s = await setupCompany();
      await corrections.setPolicy({ models: db, companyId: s.companyId, mode: 'self_service' });

      const entry = await seedSession({
        companyId: s.companyId, userId: s.emp.user.id,
        startedAt: localAt(3, '09:00'), endedAt: localAt(3, '17:00'),
      });
      const brk = await seedBreak({
        companyId: s.companyId, userId: s.emp.user.id, entry,
        type: 'regular', countsAsWork: false,
        startedAt: localAt(3, '13:00'), endedAt: localAt(3, '13:30'),
      });

      await postForm(s.empAg, '/time/corrections/', {
        type: 'break_type', target: 'break-' + brk.id,
        break_type: 'justified', reason: 'it was a medical appointment',
      });

      const fresh = await db.TimeBreak.findByPk(brk.id);
      assert.strictEqual(fresh.type, 'justified');
      assert.strictEqual(fresh.countsAsWork, false, 'the historical criterion is preserved');
    });

    it('changes the work modality and keeps the original in the audit trail', async () => {
      const s = await setupCompany();
      await corrections.setPolicy({ models: db, companyId: s.companyId, mode: 'self_service' });

      const entry = await seedSession({
        companyId: s.companyId, userId: s.emp.user.id,
        startedAt: localAt(3, '09:00'), endedAt: localAt(3, '17:00'), modality: 'office',
      });

      await postForm(s.empAg, '/time/corrections/', {
        type: 'modality', target: 'entry-' + entry.id,
        modality: 'remote', reason: 'I worked from home that day.',
      });

      const fresh = await db.TimeEntry.findByPk(entry.id);
      assert.strictEqual(fresh.modality, 'remote');

      const event = await db.TimeEntryEvent.findOne({
        where: { timeEntryId: entry.id, type: 'correction' },
      });
      const payload = JSON.parse(event.payload);
      assert.strictEqual(payload.from, 'office');
      assert.strictEqual(payload.to, 'remote');

      // The original 'in' event still says office.
      const inEvent = await db.TimeEntryEvent.findOne({
        where: { timeEntryId: entry.id, type: 'in' },
      });
      assert.strictEqual(inEvent.modality, 'office');
    });

    it('refuses a clock-out while a break is active', async () => {
      const s = await setupCompany();
      const entry = await seedSession({
        companyId: s.companyId, userId: s.emp.user.id,
        startedAt: localAt(3, '09:00'), endedAt: null,
      });
      await seedBreak({
        companyId: s.companyId, userId: s.emp.user.id, entry,
        startedAt: localAt(3, '13:00'), endedAt: null,
      });

      const res = await postForm(s.empAg, '/time/corrections/', {
        type: 'entry_end', target: 'entry-' + entry.id,
        date: localDate(3), time: '17:00', reason: 'forgot to clock out',
      });
      assert.ok([302, 303].includes(res.status));
      assert.strictEqual(
        await db.TimeCorrection.count({ where: { userId: s.emp.user.id } }), 0,
        'the request was refused'
      );
    });

    it('refuses a correction that would overlap another break', async () => {
      const s = await setupCompany();
      const entry = await seedSession({
        companyId: s.companyId, userId: s.emp.user.id,
        startedAt: localAt(3, '09:00'), endedAt: localAt(3, '17:00'),
      });
      // The break that has to be corrected.
      const brk = await seedBreak({
        companyId: s.companyId, userId: s.emp.user.id, entry,
        startedAt: localAt(3, '14:00'), endedAt: localAt(3, '14:30'),
      });
      // Another break that the corrected one would run into.
      await seedBreak({
        companyId: s.companyId, userId: s.emp.user.id, entry,
        startedAt: localAt(3, '13:00'), endedAt: localAt(3, '13:30'),
      });

      const res = await postForm(s.empAg, '/time/corrections/', {
        type: 'break_start', target: 'break-' + brk.id,
        date: localDate(3), time: '13:15', reason: 'overlapping',
      });
      assert.ok([302, 303].includes(res.status));
      assert.strictEqual(
        await db.TimeCorrection.count({ where: { userId: s.emp.user.id } }), 0
      );
    });

    it('refuses a correction that would overlap another session', async () => {
      const s = await setupCompany();
      await seedSession({
        companyId: s.companyId, userId: s.emp.user.id,
        startedAt: localAt(3, '13:00'), endedAt: localAt(3, '14:00'),
      });
      const entry = await seedSession({
        companyId: s.companyId, userId: s.emp.user.id,
        startedAt: localAt(3, '09:00'), endedAt: localAt(3, '17:00'),
      });

      const res = await postForm(s.empAg, '/time/corrections/', {
        type: 'entry_end', target: 'entry-' + entry.id,
        date: localDate(3), time: '13:30', reason: 'overlapping',
      });
      assert.ok([302, 303].includes(res.status));
      assert.strictEqual(
        await db.TimeCorrection.count({ where: { userId: s.emp.user.id } }), 0
      );
    });

    it('refuses a clock-in in the future', async () => {
      const s = await setupCompany();
      const entry = await seedSession({
        companyId: s.companyId, userId: s.emp.user.id,
        startedAt: localAt(3, '09:00'), endedAt: localAt(3, '17:00'),
      });

      const tomorrow = moment.utc().add(1, 'day').format('YYYY-MM-DD');
      const res = await postForm(s.empAg, '/time/corrections/', {
        type: 'entry_start', target: 'entry-' + entry.id,
        date: tomorrow, time: '09:00', reason: 'tomorrow',
      });
      assert.ok([302, 303].includes(res.status));
      assert.strictEqual(
        await db.TimeCorrection.count({ where: { userId: s.emp.user.id } }), 0
      );
    });
  });

  describe('conflicts between corrections', () => {
    it('a stale request is not applied blindly but is preserved', async () => {
      const s = await setupCompany();
      const entry = await seedSession({
        companyId: s.companyId, userId: s.emp.user.id,
        startedAt: localAt(3, '09:00'), endedAt: localAt(3, '17:00'),
      });

      await postForm(s.empAg, '/time/corrections/', {
        type: 'entry_end', target: 'entry-' + entry.id,
        date: localDate(3), time: '18:00', reason: 'I stayed late',
      });
      const correction = await db.TimeCorrection.findOne({ where: { userId: s.emp.user.id } });

      // Meanwhile the session changes through another mechanism.
      await db.TimeEntry.update({ endedAt: localAt(3, '17:30') }, { where: { id: entry.id } });

      const res = await postForm(s.supAg, '/time/approvals/' + correction.id + '/approve/', {});
      assert.ok([302, 303].includes(res.status));

      const fresh = await db.TimeCorrection.findByPk(correction.id);
      assert.strictEqual(fresh.status, 'conflict');
      assert.ok(fresh.conflictReason, 'the reason of the conflict is kept');

      const entry2 = await db.TimeEntry.findByPk(entry.id);
      assert.strictEqual(
        moment.utc(entry2.endedAt).tz(TZ).format('HH:mm'), '17:30',
        'the stale proposal was NOT applied'
      );
    });

    it('two incompatible corrections: the second one becomes a conflict', async () => {
      const s = await setupCompany();
      const entry = await seedSession({
        companyId: s.companyId, userId: s.emp.user.id,
        startedAt: localAt(3, '09:00'), endedAt: localAt(3, '17:00'),
      });

      // Both are individually valid when they are asked for: the second one
      // becomes impossible once the first one is applied.
      await postForm(s.empAg, '/time/corrections/', {
        type: 'entry_end', target: 'entry-' + entry.id,
        date: localDate(3), time: '15:00', reason: 'I left early',
      });
      await postForm(s.empAg, '/time/corrections/', {
        type: 'entry_start', target: 'entry-' + entry.id,
        date: localDate(3), time: '16:00', reason: 'I came in late',
      });

      const all = await db.TimeCorrection.findAll({ where: { userId: s.emp.user.id } });
      assert.strictEqual(all.length, 2);

      const endRequest = all.find((c) => c.type === 'entry_end');
      const startRequest = all.find((c) => c.type === 'entry_start');

      await postForm(s.supAg, '/time/approvals/' + endRequest.id + '/approve/', {});
      await postForm(s.supAg, '/time/approvals/' + startRequest.id + '/approve/', {});

      const endFresh = await db.TimeCorrection.findByPk(endRequest.id);
      const startFresh = await db.TimeCorrection.findByPk(startRequest.id);
      assert.strictEqual(endFresh.status, 'applied');
      assert.strictEqual(startFresh.status, 'conflict', 'the incompatible request was preserved');

      const entry2 = await db.TimeEntry.findByPk(entry.id);
      assert.strictEqual(moment.utc(entry2.startedAt).tz(TZ).format('HH:mm'), '09:00');
      assert.strictEqual(moment.utc(entry2.endedAt).tz(TZ).format('HH:mm'), '15:00');
    });
  });

  describe('computation', () => {
    it('the computation is untouched while the request is pending', async () => {
      const s = await setupCompany();
      const entry = await seedSession({
        companyId: s.companyId, userId: s.emp.user.id,
        startedAt: localAt(3, '09:00'), endedAt: localAt(3, '17:00'),
      });

      const before = compute.summarize({
        startedAt: entry.startedAt, endedAt: entry.endedAt, breaks: [],
      });

      await postForm(s.empAg, '/time/corrections/', {
        type: 'entry_start', target: 'entry-' + entry.id,
        date: localDate(3), time: '08:00', reason: 'earlier',
      });

      const fresh = await db.TimeEntry.findByPk(entry.id);
      const after = compute.summarize({
        startedAt: fresh.startedAt, endedAt: fresh.endedAt, breaks: [],
      });
      assert.strictEqual(after.computedMinutes, before.computedMinutes);
      assert.strictEqual(after.computedMinutes, 8 * 60);
    });

    it('the computation uses the effective values after the correction', async () => {
      const s = await setupCompany();
      await corrections.setPolicy({ models: db, companyId: s.companyId, mode: 'self_service' });

      const entry = await seedSession({
        companyId: s.companyId, userId: s.emp.user.id,
        startedAt: localAt(3, '09:00'), endedAt: localAt(3, '17:00'),
      });
      const brk = await seedBreak({
        companyId: s.companyId, userId: s.emp.user.id, entry,
        startedAt: localAt(3, '13:00'), endedAt: localAt(3, '13:30'),
      });

      await postForm(s.empAg, '/time/corrections/', {
        type: 'entry_start', target: 'entry-' + entry.id,
        date: localDate(3), time: '09:30', reason: 'later',
      });

      const fresh = await db.TimeEntry.findByPk(entry.id);
      const breaks = await db.TimeBreak.findAll({ where: { timeEntryId: entry.id } });
      const totals = compute.summarize({
        startedAt: fresh.startedAt, endedAt: fresh.endedAt, breaks,
      });
      // 09:30 -> 17:00 = 7h30 minus a 30 min break that does not count.
      assert.strictEqual(totals.computedMinutes, 7 * 60);
      assert.strictEqual(breaks[0].id, brk.id);
    });
  });

  describe('audit trail', () => {
    it('the original events survive an applied correction', async () => {
      const s = await setupCompany();
      await corrections.setPolicy({ models: db, companyId: s.companyId, mode: 'self_service' });

      const entry = await seedSession({
        companyId: s.companyId, userId: s.emp.user.id,
        startedAt: localAt(3, '09:17'), endedAt: localAt(3, '17:03'),
      });

      await postForm(s.empAg, '/time/corrections/', {
        type: 'entry_start', target: 'entry-' + entry.id,
        date: localDate(3), time: '09:00', reason: 'forgot to clock in',
      });

      const events = await db.TimeEntryEvent.findAll({
        where: { timeEntryId: entry.id }, order: [['id', 'ASC']],
      });
      assert.deepStrictEqual(events.map((e) => e.type), ['in', 'out', 'correction']);
      assert.strictEqual(
        moment.utc(events[0].occurredAt).tz(TZ).format('HH:mm'), '09:17',
        'the original clock-in was not rewritten'
      );
      assert.strictEqual(
        moment.utc(events[1].occurredAt).tz(TZ).format('HH:mm'), '17:03',
        'the original clock-out was not rewritten'
      );

      const payload = JSON.parse(events[2].payload);
      assert.strictEqual(payload.from, moment.utc(entry.startedAt).toISOString());
      assert.strictEqual(payload.to, moment.tz(`${localDate(3)} 09:00`, 'YYYY-MM-DD HH:mm', TZ).toISOString());
      assert.strictEqual(payload.reason, 'forgot to clock in');
      assert.strictEqual(payload.requestedBy, s.emp.user.id);
      assert.strictEqual(payload.resolvedBy, s.emp.user.id);
      assert.strictEqual(payload.origin, 'correction');
    });

    it('writes the company audit rows', async () => {
      const s = await setupCompany();
      await corrections.setPolicy({ models: db, companyId: s.companyId, mode: 'self_service' });

      const entry = await seedSession({
        companyId: s.companyId, userId: s.emp.user.id,
        startedAt: localAt(3, '09:17'), endedAt: localAt(3, '17:03'),
      });

      await postForm(s.empAg, '/time/corrections/', {
        type: 'entry_start', target: 'entry-' + entry.id,
        date: localDate(3), time: '09:00', reason: 'forgot to clock in',
      });

      const correction = await db.TimeCorrection.findOne({ where: { userId: s.emp.user.id } });
      const rows = await db.Audit.findAll({
        where: { entityType: 'TIME_CORRECTION', entityId: correction.id },
      });
      const attributes = rows.map((r) => r.attribute);
      ['status', 'type', 'policy', 'reason', 'original_value', 'proposed_value', 'resolved_by']
        .forEach((a) => assert.ok(attributes.includes(a), 'missing audit attribute ' + a));

      const statusRow = rows.find((r) => r.attribute === 'status');
      assert.strictEqual(statusRow.oldValue, 'pending');
      assert.strictEqual(statusRow.newValue, 'applied');
      assert.strictEqual(String(statusRow.byUserId), String(s.emp.user.id));
    });

    it('keeps the policy of the request when the company policy changes', async () => {
      const s = await setupCompany();
      const entry = await seedSession({
        companyId: s.companyId, userId: s.emp.user.id,
        startedAt: localAt(3, '09:17'), endedAt: localAt(3, '17:03'),
      });

      await postForm(s.empAg, '/time/corrections/', {
        type: 'entry_start', target: 'entry-' + entry.id,
        date: localDate(3), time: '09:00', reason: 'forgot to clock in',
      });
      const correction = await db.TimeCorrection.findOne({ where: { userId: s.emp.user.id } });
      assert.strictEqual(correction.policy, 'approval_required');

      // The company switches to self-service: the pending request is NOT applied.
      await corrections.setPolicy({ models: db, companyId: s.companyId, mode: 'self_service' });
      const still = await db.TimeCorrection.findByPk(correction.id);
      assert.strictEqual(still.status, 'pending', 'changing the policy does not approve requests');
      assert.strictEqual(still.policy, 'approval_required', 'the request keeps its policy');

      // And the other way round.
      await corrections.setPolicy({ models: db, companyId: s.companyId, mode: 'self_service' });
      const second = await seedSession({
        companyId: s.companyId, userId: s.emp.user.id,
        startedAt: localAt(2, '09:17'), endedAt: localAt(2, '17:03'),
      });
      await postForm(s.empAg, '/time/corrections/', {
        type: 'entry_start', target: 'entry-' + second.id,
        date: localDate(2), time: '09:00', reason: 'forgot to clock in',
      });
      const applied = await db.TimeCorrection.findOne({
        where: { userId: s.emp.user.id, timeEntryId: second.id },
      });
      assert.strictEqual(applied.policy, 'self_service');
      assert.strictEqual(applied.status, 'applied');

      await corrections.setPolicy({ models: db, companyId: s.companyId, mode: 'approval_required' });
      const after = await db.TimeCorrection.findByPk(applied.id);
      assert.strictEqual(after.status, 'applied', 'changing the policy does not revert corrections');
    });
  });

  describe('timezone and DST', () => {
    it('refuses a time that does not exist because of the DST change', async () => {
      const s = await setupCompany();
      await corrections.setPolicy({ models: db, companyId: s.companyId, mode: 'self_service' });

      const entry = await seedSession({
        companyId: s.companyId, userId: s.emp.user.id,
        startedAt: moment.tz('2026-03-28 09:00', 'YYYY-MM-DD HH:mm', TZ).toDate(),
        endedAt: moment.tz('2026-03-28 17:00', 'YYYY-MM-DD HH:mm', TZ).toDate(),
      });

      const res = await postForm(s.empAg, '/time/corrections/', {
        type: 'entry_start', target: 'entry-' + entry.id,
        date: '2026-03-29', time: '02:30', reason: 'DST gap',
      });
      assert.ok([302, 303].includes(res.status));
      assert.strictEqual(
        await db.TimeCorrection.count({ where: { userId: s.emp.user.id } }), 0,
        'a time that does not exist is refused'
      );
    });

    it('interprets the declared time in the effective timezone', async () => {
      const s = await setupCompany();
      await corrections.setPolicy({ models: db, companyId: s.companyId, mode: 'self_service' });

      const entry = await seedSession({
        companyId: s.companyId, userId: s.emp.user.id,
        startedAt: localAt(3, '09:17'), endedAt: localAt(3, '17:03'),
      });

      await postForm(s.empAg, '/time/corrections/', {
        type: 'entry_start', target: 'entry-' + entry.id,
        date: localDate(3), time: '09:00', reason: 'forgot to clock in',
      });

      const fresh = await db.TimeEntry.findByPk(entry.id);
      // Europe/Madrid in winter is UTC+1: 09:00 local is 08:00 UTC.
      assert.strictEqual(moment.utc(fresh.startedAt).format('HH:mm'), '08:00');
      assert.strictEqual(moment.utc(fresh.startedAt).tz(TZ).format('HH:mm'), '09:00');
    });

    it('computes the real duration across a DST change', async () => {
      const s = await setupCompany();
      const entry = await seedSession({
        companyId: s.companyId, userId: s.emp.user.id,
        startedAt: moment.tz('2026-03-29 00:00', 'YYYY-MM-DD HH:mm', TZ).toDate(),
        endedAt: moment.tz('2026-03-29 05:00', 'YYYY-MM-DD HH:mm', TZ).toDate(),
      });

      const totals = compute.summarize({
        startedAt: entry.startedAt, endedAt: entry.endedAt, breaks: [],
      });
      // The night of the spring change is 4 real hours long, not 5.
      assert.strictEqual(totals.computedMinutes, 4 * 60);
    });
  });

  describe('security', () => {
    it('rejects a correction request without a CSRF token', async () => {
      const s = await setupCompany();
      const entry = await seedSession({
        companyId: s.companyId, userId: s.emp.user.id,
        startedAt: localAt(3, '09:17'), endedAt: localAt(3, '17:03'),
      });

      const res = await s.empAg.post('/time/corrections/').type('form').send({
        type: 'entry_start', target: 'entry-' + entry.id,
        date: localDate(3), time: '09:00', reason: 'no token',
      });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(
        await db.TimeCorrection.count({ where: { userId: s.emp.user.id } }), 0
      );
    });

    it('rejects a multipart correction request', async () => {
      const s = await setupCompany();
      const res = await s.empAg.post('/time/corrections/')
        .attach('file', Buffer.from('x'), 'x.txt');
      assert.strictEqual(res.status, 403);
      assert.strictEqual(
        await db.TimeCorrection.count({ where: { userId: s.emp.user.id } }), 0
      );
    });

    it('ignores a timestamp sent by the browser', async () => {
      const s = await setupCompany();
      await corrections.setPolicy({ models: db, companyId: s.companyId, mode: 'self_service' });

      const entry = await seedSession({
        companyId: s.companyId, userId: s.emp.user.id,
        startedAt: localAt(3, '09:17'), endedAt: localAt(3, '17:03'),
      });

      await postForm(s.empAg, '/time/corrections/', {
        type: 'entry_start', target: 'entry-' + entry.id,
        date: localDate(3), time: '09:00',
        // The browser tries to force an instant: it is ignored.
        started_at: '2030-01-01T00:00:00.000Z',
        ended_at: '2030-01-01T23:00:00.000Z',
        occurred_at: '2030-01-01T00:00:00.000Z',
        reason: 'forgot to clock in',
      });

      const fresh = await db.TimeEntry.findByPk(entry.id);
      assert.strictEqual(moment.utc(fresh.startedAt).tz(TZ).format('HH:mm'), '09:00');
      assert.strictEqual(moment.utc(fresh.startedAt).format('YYYY'), moment.utc().format('YYYY'));
    });

    it('does not let one company touch the requests of another one', async () => {
      const s = await setupCompany();
      const entry = await seedSession({
        companyId: s.companyId, userId: s.emp.user.id,
        startedAt: localAt(3, '09:17'), endedAt: localAt(3, '17:03'),
      });
      await postForm(s.empAg, '/time/corrections/', {
        type: 'entry_start', target: 'entry-' + entry.id,
        date: localDate(3), time: '09:00', reason: 'forgot to clock in',
      });
      const correction = await db.TimeCorrection.findOne({ where: { userId: s.emp.user.id } });

      const otherAdminAg = agent();
      await registerAdmin(otherAdminAg);

      const list = await otherAdminAg.get('/time/approvals/');
      assert.strictEqual(list.status, 200);
      assert.ok(!/forgot to clock in/.test(list.text), 'the other company sees nothing');
    });
  });

  describe('database errors and rollback', () => {
    it('rolls the whole request back when the database fails', async () => {
      const s = await setupCompany();
      await corrections.setPolicy({ models: db, companyId: s.companyId, mode: 'self_service' });

      const entry = await seedSession({
        companyId: s.companyId, userId: s.emp.user.id,
        startedAt: localAt(3, '09:17'), endedAt: localAt(3, '17:03'),
      });

      const originalUpdate = db.TimeEntry.update;
      db.TimeEntry.update = async () => { throw new Error('database is on fire'); };
      try {
        const res = await postForm(s.empAg, '/time/corrections/', {
          type: 'entry_start', target: 'entry-' + entry.id,
          date: localDate(3), time: '09:00', reason: 'forgot to clock in',
        });
        assert.ok([302, 303].includes(res.status));
      } finally {
        db.TimeEntry.update = originalUpdate;
      }

      assert.strictEqual(
        await db.TimeCorrection.count({ where: { userId: s.emp.user.id } }), 0,
        'the transaction was rolled back: no orphan request'
      );
      const fresh = await db.TimeEntry.findByPk(entry.id);
      assert.strictEqual(
        moment.utc(fresh.startedAt).tz(TZ).format('HH:mm'), '09:17',
        'the effective record was not modified'
      );
    });
  });

  describe('compatibility with blocks 1 and 2', () => {
    it('a session without breaks still works', async () => {
      const s = await setupCompany();
      await corrections.setPolicy({ models: db, companyId: s.companyId, mode: 'self_service' });

      const entry = await seedSession({
        companyId: s.companyId, userId: s.emp.user.id,
        startedAt: localAt(3, '09:00'), endedAt: localAt(3, '17:00'),
      });

      await postForm(s.empAg, '/time/corrections/', {
        type: 'entry_start', target: 'entry-' + entry.id,
        date: localDate(3), time: '08:30', reason: 'earlier',
      });

      const fresh = await db.TimeEntry.findByPk(entry.id);
      assert.strictEqual(moment.utc(fresh.startedAt).tz(TZ).format('HH:mm'), '08:30');
      assert.strictEqual(fresh.source, 'direct');
    });

    it('the clock and the breaks still work next to the corrections', async () => {
      const s = await setupCompany();
      const res = await postForm(s.empAg, '/time/start', { modality: 'office' });
      assert.ok([302, 303].includes(res.status));

      const open = await db.TimeEntry.findOne({ where: { userId: s.emp.user.id, status: 'open' } });
      assert.ok(open);
      assert.strictEqual(open.source, 'direct');
      assert.strictEqual(open.version, 1);

      await postForm(s.empAg, '/time/break/start', { type: 'regular' });
      await postForm(s.empAg, '/time/break/stop', {});
      const brk = await db.TimeBreak.findOne({ where: { userId: s.emp.user.id } });
      assert.ok(brk.endedAt);

      await postForm(s.empAg, '/time/stop', {});
      const closed = await db.TimeEntry.findByPk(open.id);
      assert.strictEqual(closed.status, 'closed');
      assert.strictEqual(closed.version, 2, 'the version is incremented on every effective change');
    });

    it('the /time page shows the declared and corrected sessions', async () => {
      const s = await setupCompany();
      await corrections.setPolicy({ models: db, companyId: s.companyId, mode: 'self_service' });

      await postForm(s.empAg, '/time/corrections/', {
        type: 'missing_entry',
        date: localDate(4), time: '09:00', end_time: '17:00',
        modality: 'office', reason: 'I forgot to clock in and out.',
      });

      const page = await s.empAg.get('/time/');
      assert.strictEqual(page.status, 200);
      assert.ok(/declared/.test(page.text), 'the declared session is marked as such');
    });
  });
});
