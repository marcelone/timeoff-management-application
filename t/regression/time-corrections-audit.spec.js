'use strict';

/*
 * Time tracking — block 3: audit, concurrency and authorisation at service level.
 *
 * These checks complement t/regression/time-corrections.spec.js:
 *   - the authorisation to resolve a request is decided by the SERVICE, not only
 *     by the routes (a caller that bypasses the routes gets the same answer);
 *   - two concurrent resolutions cannot both win, and a request can never end up
 *     approved and rejected at the same time;
 *   - the database refuses two pending requests for the same target even if the
 *     application check is bypassed;
 *   - the audit trail is complete for every outcome (applied, rejected,
 *     conflict, cancelled).
 */

const assert = require('assert');
const moment = require('moment-timezone');
const H = require('./helper');
const { agent, db, postForm, registerAdmin, addEmployee, login } = H;

const corrections = require('../../lib/modules/time/corrections');

const TZ = 'Europe/Madrid';

function localDate(daysAgo) {
  return moment.utc().subtract(daysAgo, 'days').format('YYYY-MM-DD');
}

function localAt(daysAgo, hhmm) {
  return moment.tz(`${localDate(daysAgo)} ${hhmm}`, 'YYYY-MM-DD HH:mm', TZ).toDate();
}

async function seedSession({ companyId, userId, startedAt, endedAt }) {
  const entry = await db.TimeEntry.create({
    companyId, userId, modality: 'office',
    status: endedAt ? 'closed' : 'open',
    source: 'direct', version: 1,
    startedAt, endedAt: endedAt || null,
  });
  await db.TimeEntryEvent.create({
    companyId, userId, timeEntryId: entry.id, type: 'in',
    occurredAt: startedAt, source: 'direct', modality: 'office',
  });
  if (endedAt) {
    await db.TimeEntryEvent.create({
      companyId, userId, timeEntryId: entry.id, type: 'out',
      occurredAt: endedAt, source: 'direct', modality: 'office',
    });
  }
  return entry;
}

async function setupCompany() {
  const adminAg = agent();
  const { user: admin } = await registerAdmin(adminAg);
  const companyId = admin.companyId;
  const dept = await db.Department.findOne({ where: { companyId } });

  const sup = await addEmployee(adminAg, companyId, { name: 'Sup', lastname: 'Ervisor' });
  const emp = await addEmployee(adminAg, companyId, { name: 'Emp', lastname: 'Loyee' });
  dept.bossId = sup.user.id;
  await dept.save();

  const supAg = agent();
  await login(supAg, sup.email, sup.password);
  const empAg = agent();
  await login(empAg, emp.email, emp.password);

  return { adminAg, admin, companyId, dept, sup, emp, supAg, empAg };
}

async function createPendingRequest(s, overrides = {}) {
  const entry = await seedSession({
    companyId: s.companyId, userId: s.emp.user.id,
    startedAt: localAt(3, '09:17'), endedAt: localAt(3, '17:03'),
  });
  await postForm(s.empAg, '/time/corrections/', {
    type: 'entry_start', target: 'entry-' + entry.id,
    date: localDate(3), time: '09:00', reason: 'forgot to clock in',
  });
  const correction = await db.TimeCorrection.findOne({ where: { userId: s.emp.user.id } });
  return { entry, correction: Object.assign(correction, overrides) };
}

describe('time tracking — block 3 (audit, concurrency, authorisation)', function () {

  // The suite shares one database: the requests are removed at the end of this
  // file so that the block-2 migration test can drop the break table.
  after(async () => {
    await db.TimeCorrection.destroy({ where: {} });
    await db.Audit.destroy({ where: { entityType: 'TIME_CORRECTION' } });
  });

  describe('authorisation at service level', () => {
    it('only a supervisor, an owner/admin or the employee itself can be involved', async () => {
      const s = await setupCompany();
      const { correction } = await createPendingRequest(s);

      const supervisorUser = await db.User.findByPk(s.sup.user.id);
      const employeeUser = await db.User.findByPk(s.emp.user.id);
      const adminUser = await db.User.findByPk(s.admin.id);
      const plain = await addEmployee(s.adminAg, s.companyId, { name: 'Plain', lastname: 'E' });
      const plainUser = await db.User.findByPk(plain.user.id);

      assert.strictEqual(
        await corrections.canResolve({ models: db, actor: supervisorUser, correction }), true,
        'the supervisor of the employee can resolve'
      );
      assert.strictEqual(
        await corrections.canResolve({ models: db, actor: adminUser, correction }), true,
        'the owner/admin can resolve'
      );
      assert.strictEqual(
        await corrections.canResolve({ models: db, actor: plainUser, correction }), false,
        'a plain employee cannot resolve'
      );
      assert.strictEqual(
        await corrections.canResolve({ models: db, actor: employeeUser, correction }), false,
        'the requester cannot resolve their own request'
      );
    });

    it('refuses a resolution that comes from another company', async () => {
      const s = await setupCompany();
      const { correction } = await createPendingRequest(s);

      const otherAdminAg = agent();
      const other = await registerAdmin(otherAdminAg);
      const otherUser = await db.User.findByPk(other.user.id);

      assert.strictEqual(
        await corrections.canResolve({ models: db, actor: otherUser, correction }), false
      );
      await assert.rejects(
        () => corrections.resolveRequest({
          models: db, actor: otherUser, correctionId: correction.id, decision: 'approve',
        }),
        /Unknown correction request/i
      );
    });

    it('the service refuses the self-approval of an ordinary supervisor', async () => {
      const s = await setupCompany();
      const entry = await seedSession({
        companyId: s.companyId, userId: s.sup.user.id,
        startedAt: localAt(3, '09:17'), endedAt: localAt(3, '17:03'),
      });
      const supUser = await db.User.findByPk(s.sup.user.id);
      await corrections.createRequest({
        models: db, actor: supUser, type: 'entry_start', entryId: entry.id,
        input: { date: localDate(3), time: '09:00', reason: 'forgot to clock in' },
        timezone: TZ,
      });
      const correction = await db.TimeCorrection.findOne({ where: { userId: s.sup.user.id } });

      // Being the boss of the department is NOT an administrative role.
      assert.strictEqual(
        await corrections.canResolve({ models: db, actor: supUser, correction }), false
      );

      await assert.rejects(
        () => corrections.resolveRequest({
          models: db, actor: supUser, correctionId: correction.id, decision: 'approve',
        }),
        /cannot resolve your own/i
      );
      const fresh = await db.TimeCorrection.findByPk(correction.id);
      assert.strictEqual(fresh.status, 'pending');
      assert.strictEqual(fresh.selfApproved, false);
    });

    it('the service allows the administrative self-approval of the owner and records it', async () => {
      const s = await setupCompany();
      const entry = await seedSession({
        companyId: s.companyId, userId: s.admin.id,
        startedAt: localAt(3, '09:17'), endedAt: localAt(3, '17:03'),
      });
      const adminUser = await db.User.findByPk(s.admin.id);
      await corrections.createRequest({
        models: db, actor: adminUser, type: 'entry_start', entryId: entry.id,
        input: { date: localDate(3), time: '09:00', reason: 'forgot to clock in' },
        timezone: TZ,
      });
      const correction = await db.TimeCorrection.findOne({ where: { userId: s.admin.id } });

      assert.strictEqual(
        await corrections.canResolve({ models: db, actor: adminUser, correction }), true
      );

      const result = await corrections.resolveRequest({
        models: db, actor: adminUser, correctionId: correction.id, decision: 'approve',
      });
      assert.strictEqual(result.status, 'applied');
      assert.strictEqual(result.selfApproval, true);

      const fresh = await db.TimeCorrection.findByPk(correction.id);
      assert.strictEqual(fresh.status, 'applied');
      assert.strictEqual(fresh.selfApproved, true);
      assert.strictEqual(String(fresh.resolvedById), String(s.admin.id));

      const rows = await db.Audit.findAll({
        where: { entityType: 'TIME_CORRECTION', entityId: correction.id },
      });
      const flag = rows.find((r) => r.attribute === 'administrative_self_approval');
      assert.ok(flag, 'the administrative self-approval is audited explicitly');
      const payload = JSON.parse(flag.newValue);
      assert.strictEqual(payload.selfApproved, true);
      assert.strictEqual(String(payload.resolvedById), String(s.admin.id));
    });
  });

  describe('concurrency', () => {
    it('two concurrent approvals: only one is applied', async () => {
      const s = await setupCompany();
      const { correction } = await createPendingRequest(s);

      const supervisorUser = await db.User.findByPk(s.sup.user.id);

      const results = await Promise.allSettled([
        corrections.resolveRequest({
          models: db, actor: supervisorUser, correctionId: correction.id, decision: 'approve',
        }),
        corrections.resolveRequest({
          models: db, actor: supervisorUser, correctionId: correction.id, decision: 'approve',
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      assert.strictEqual(fulfilled.length, 1, 'exactly one resolution succeeded');

      const fresh = await db.TimeCorrection.findByPk(correction.id);
      assert.strictEqual(fresh.status, 'applied');
      assert.strictEqual(
        await db.TimeEntryEvent.count({
          where: { timeEntryId: correction.timeEntryId, type: 'correction' },
        }),
        1, 'the correction was applied exactly once'
      );
    });

    it('a concurrent approval and rejection cannot both win', async () => {
      const s = await setupCompany();
      const { correction } = await createPendingRequest(s);

      const supervisorUser = await db.User.findByPk(s.sup.user.id);

      const results = await Promise.allSettled([
        corrections.resolveRequest({
          models: db, actor: supervisorUser, correctionId: correction.id, decision: 'approve',
        }),
        corrections.resolveRequest({
          models: db, actor: supervisorUser, correctionId: correction.id, decision: 'reject',
          reason: 'not acceptable',
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      assert.strictEqual(fulfilled.length, 1, 'exactly one resolution succeeded');

      const fresh = await db.TimeCorrection.findByPk(correction.id);
      assert.ok(['applied', 'rejected'].includes(fresh.status));
      if (fresh.status === 'rejected') {
        assert.strictEqual(fresh.rejectionReason, 'not acceptable');
      } else {
        assert.strictEqual(fresh.rejectionReason, null);
      }
    });

    it('the database refuses two pending requests for the same target', async () => {
      const s = await setupCompany();
      const { entry, correction } = await createPendingRequest(s);

      await assert.rejects(
        () => db.TimeCorrection.create({
          companyId: s.companyId, userId: s.emp.user.id,
          timeEntryId: entry.id, type: 'entry_start', status: 'pending',
          targetKey: correction.targetKey,
          originalValue: null, proposedValue: '{"startedAt":"2026-01-01T08:00:00.000Z"}',
          reason: 'duplicate', policy: 'approval_required',
        }),
        /unique|constraint/i,
        'the partial unique index refuses the duplicate'
      );
    });
  });

  describe('audit trail of every outcome', () => {
    it('records the rejection', async () => {
      const s = await setupCompany();
      const { correction } = await createPendingRequest(s);

      await postForm(s.supAg, '/time/approvals/' + correction.id + '/reject/', {
        reason: 'the manager already fixed it',
      });

      const rows = await db.Audit.findAll({
        where: { entityType: 'TIME_CORRECTION', entityId: correction.id },
      });
      const status = rows.find((r) => r.attribute === 'status');
      assert.ok(status, 'the status change is audited');
      assert.strictEqual(status.oldValue, 'pending');
      assert.strictEqual(status.newValue, 'rejected');
    });

    it('records a conflict without applying anything', async () => {
      const s = await setupCompany();
      const entry = await seedSession({
        companyId: s.companyId, userId: s.emp.user.id,
        startedAt: localAt(3, '09:00'), endedAt: localAt(3, '17:00'),
      });

      // The request wants to move the clock-out to 18:00.
      await postForm(s.empAg, '/time/corrections/', {
        type: 'entry_end', target: 'entry-' + entry.id,
        date: localDate(3), time: '18:00', reason: 'I stayed late',
      });
      const correction = await db.TimeCorrection.findOne({ where: { userId: s.emp.user.id } });

      // The session changes through another mechanism: the value the request was
      // written against (17:00) is no longer the current one (17:30).
      await db.TimeEntry.update({ endedAt: localAt(3, '17:30') }, { where: { id: entry.id } });

      await postForm(s.supAg, '/time/approvals/' + correction.id + '/approve/', {});

      const fresh = await db.TimeCorrection.findByPk(correction.id);
      assert.strictEqual(fresh.status, 'conflict');
      assert.ok(fresh.conflictReason, 'the reason of the conflict is kept');

      const rows = await db.Audit.findAll({
        where: { entityType: 'TIME_CORRECTION', entityId: correction.id },
      });
      const status = rows.find((r) => r.attribute === 'status');
      assert.strictEqual(status.newValue, 'conflict');

      const entry2 = await db.TimeEntry.findByPk(entry.id);
      assert.strictEqual(
        moment.utc(entry2.endedAt).tz(TZ).format('HH:mm'), '17:30',
        'the stale proposal was not applied'
      );
    });

    it('records the cancellation of a pending request', async () => {
      const s = await setupCompany();
      const { correction } = await createPendingRequest(s);

      const res = await postForm(s.empAg, '/time/corrections/' + correction.id + '/cancel/', {});
      assert.ok([302, 303].includes(res.status));

      const fresh = await db.TimeCorrection.findByPk(correction.id);
      assert.strictEqual(fresh.status, 'cancelled');
      assert.strictEqual(String(fresh.resolvedById), String(s.emp.user.id));

      // The target is free again: a new request for it is accepted.
      const again = await postForm(s.empAg, '/time/corrections/', {
        type: 'entry_start', target: 'entry-' + correction.timeEntryId,
        date: localDate(3), time: '09:05', reason: 'still forgot to clock in',
      });
      assert.ok([302, 303].includes(again.status));
      assert.strictEqual(
        await db.TimeCorrection.count({ where: { userId: s.emp.user.id, status: 'pending' } }), 1
      );
    });

    it('the employee can only cancel their own request', async () => {
      const s = await setupCompany();
      const { correction } = await createPendingRequest(s);

      const res = await postForm(s.supAg, '/time/corrections/' + correction.id + '/cancel/', {});
      assert.ok([302, 303].includes(res.status));

      const fresh = await db.TimeCorrection.findByPk(correction.id);
      assert.strictEqual(fresh.status, 'pending', 'the request was not cancelled by somebody else');
    });
  });
});
