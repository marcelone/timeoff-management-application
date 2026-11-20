'use strict';

/*
 * Time tracking — block 3 (adjustment): administrative self-approval.
 *
 * The rule under test:
 *   - with the 'approval_required' policy, the requester may resolve their OWN
 *     request only as an explicit administrative exception: they must hold the
 *     administrative role of the company (owner/admin) and the request must
 *     belong to their company;
 *   - an ordinary supervisor (Department.boss or DepartmentSupervisor) and an
 *     ordinary employee can NEVER approve their own request;
 *   - with the 'self_service' policy nothing changes: the correction is applied
 *     when it is requested and there is no approval at all.
 *
 * Twelve regressions:
 *    1  the owner approves their own correction
 *    2  the admin approves their own correction
 *    3  an ordinary supervisor is refused when they try to approve their own
 *    4  an ordinary employee is refused when they try to approve their own
 *    5  an owner/admin cannot approve a request of another company
 *    6  the administrative self-approval with an invalid temporal correction
 *    7  two concurrent self-approvals: only one is applied
 *    8  the administrative self-approval with a version conflict
 *    9  the explicit audit of the administrative self-approval
 *   10  the 'self_service' mode keeps working exactly as before
 *   11  the pending requests that already exist remain resolvable
 *   12  CSRF and the authorisation at service level
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

/**
 * A company with an owner (RBAC role 'owner'), a second administrator
 * (admin = true), a supervisor (boss of the department) and an ordinary
 * employee. Everybody is logged in with their own agent.
 */
async function setupCompany() {
  const adminAg = agent();
  const { user: admin } = await registerAdmin(adminAg);
  const companyId = admin.companyId;
  const dept = await db.Department.findOne({ where: { companyId } });

  // The owner: the RBAC catalog defines the role, the application never
  // assigns it, so it is set here to exercise that path explicitly.
  const owner = await addEmployee(adminAg, companyId, { name: 'Own', lastname: 'Er' });
  const ownerUser = await db.User.findByPk(owner.user.id);
  ownerUser.role = 'owner';
  ownerUser.admin = false;
  await ownerUser.save();

  // A second administrator (admin = true).
  const admin2 = await addEmployee(adminAg, companyId, {
    name: 'Adm', lastname: 'In', admin: true,
  });

  const sup = await addEmployee(adminAg, companyId, { name: 'Sup', lastname: 'Ervisor' });
  const emp = await addEmployee(adminAg, companyId, { name: 'Emp', lastname: 'Loyee' });

  dept.bossId = sup.user.id;
  await dept.save();

  const ownerAg = agent();
  await login(ownerAg, owner.email, owner.password);
  const admin2Ag = agent();
  await login(admin2Ag, admin2.email, admin2.password);
  const supAg = agent();
  await login(supAg, sup.email, sup.password);
  const empAg = agent();
  await login(empAg, emp.email, emp.password);

  return {
    adminAg, admin, admin2, owner, companyId, dept, sup, emp,
    ownerAg, admin2Ag, supAg, empAg,
  };
}

/** A correction request submitted through the real route by a real employee. */
async function requestOf(s, user, userAgent, opts = {}) {
  const daysAgo = opts.daysAgo === undefined ? 3 : opts.daysAgo;
  const entry = await seedSession({
    companyId: s.companyId, userId: user.id,
    startedAt: localAt(daysAgo, '09:17'), endedAt: localAt(daysAgo, '17:03'),
  });
  await postForm(userAgent, '/time/corrections/', {
    type: 'entry_start', target: 'entry-' + entry.id,
    date: localDate(daysAgo), time: opts.time || '09:00',
    reason: opts.reason || 'forgot to clock in',
  });
  const correction = await db.TimeCorrection.findOne({
    where: { userId: user.id },
    order: [['id', 'DESC']],
  });
  return { entry, correction };
}

describe('time tracking — block 3 (administrative self-approval)', function () {

  // The suite shares one database: the requests are removed at the end of the
  // file so that the other block-3 files start from a clean state.
  after(async () => {
    await db.TimeCorrection.destroy({ where: {} });
    await db.Audit.destroy({ where: { entityType: 'TIME_CORRECTION' } });
  });

  it('1. the owner approves their own correction', async () => {
    const s = await setupCompany();
    const ownerUser = await db.User.findByPk(s.owner.user.id);
    const { entry, correction } = await requestOf(s, ownerUser, s.ownerAg);

    assert.strictEqual(correction.status, 'pending');
    assert.strictEqual(correction.selfApproved, false, 'a pending request is not flagged');

    const res = await postForm(s.ownerAg, '/time/approvals/' + correction.id + '/approve/', {});
    assert.ok([302, 303].includes(res.status));

    const fresh = await db.TimeCorrection.findByPk(correction.id);
    assert.strictEqual(fresh.status, 'applied', 'the owner applies their own request');
    assert.strictEqual(fresh.selfApproved, true, 'the administrative exception is flagged');
    assert.strictEqual(String(fresh.resolvedById), String(ownerUser.id));

    // The effective record changed and the original events survived.
    const entryAfter = await db.TimeEntry.findByPk(entry.id);
    assert.strictEqual(moment.utc(entryAfter.startedAt).tz(TZ).format('HH:mm'), '09:00');
    assert.strictEqual(
      await db.TimeEntryEvent.count({ where: { timeEntryId: entry.id, type: 'correction' } }), 1
    );
    assert.strictEqual(
      await db.TimeEntryEvent.count({ where: { timeEntryId: entry.id, type: 'in' } }), 1,
      'the original clock-in event is still there'
    );
  });

  it('2. the admin approves their own correction', async () => {
    const s = await setupCompany();
    const admin2User = await db.User.findByPk(s.admin2.user.id);
    const { correction } = await requestOf(s, admin2User, s.admin2Ag);

    const res = await postForm(s.admin2Ag, '/time/approvals/' + correction.id + '/approve/', {});
    assert.ok([302, 303].includes(res.status));

    const fresh = await db.TimeCorrection.findByPk(correction.id);
    assert.strictEqual(fresh.status, 'applied');
    assert.strictEqual(fresh.selfApproved, true);
    assert.strictEqual(String(fresh.resolvedById), String(admin2User.id));
  });

  it('3. an ordinary supervisor is refused when they try to approve their own request', async () => {
    const s = await setupCompany();
    const supUser = await db.User.findByPk(s.sup.user.id);
    const { correction } = await requestOf(s, supUser, s.supAg);

    assert.strictEqual(
      await corrections.canResolve({ models: db, actor: supUser, correction }), false,
      'being the boss of the department does not allow a self-approval'
    );

    await assert.rejects(
      () => corrections.resolveRequest({
        models: db, actor: supUser, correctionId: correction.id, decision: 'approve',
      }),
      /cannot resolve your own/i
    );

    const res = await postForm(s.supAg, '/time/approvals/' + correction.id + '/approve/', {});
    assert.ok([302, 303].includes(res.status));

    const fresh = await db.TimeCorrection.findByPk(correction.id);
    assert.strictEqual(fresh.status, 'pending', 'the request is still waiting');
    assert.strictEqual(fresh.selfApproved, false);

    // The screen does not even offer the action on their own request.
    const screen = await s.supAg.get('/time/approvals/');
    assert.strictEqual(screen.status, 200);
    assert.ok(
      !new RegExp('/time/approvals/' + correction.id + '/approve/').test(screen.text),
      'the supervisor does not see the approve action on their own request'
    );
    assert.ok(
      /You cannot decide on your own request/.test(screen.text),
      'the reason is explained'
    );
  });

  it('4. an ordinary employee is refused when they try to approve their own request', async () => {
    const s = await setupCompany();
    const empUser = await db.User.findByPk(s.emp.user.id);
    const { correction } = await requestOf(s, empUser, s.empAg);

    assert.strictEqual(
      await corrections.canResolve({ models: db, actor: empUser, correction }), false
    );
    await assert.rejects(
      () => corrections.resolveRequest({
        models: db, actor: empUser, correctionId: correction.id, decision: 'approve',
      }),
      /cannot resolve your own/i
    );

    const res = await postForm(s.empAg, '/time/approvals/' + correction.id + '/approve/', {});
    assert.ok([302, 303].includes(res.status));

    const fresh = await db.TimeCorrection.findByPk(correction.id);
    assert.strictEqual(fresh.status, 'pending');
    assert.strictEqual(fresh.selfApproved, false);
  });

  it('5. an owner/admin cannot approve a request of another company', async () => {
    const s = await setupCompany();
    const { correction } = await requestOf(s, s.emp.user, s.empAg);

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

    const res = await postForm(otherAdminAg, '/time/approvals/' + correction.id + '/approve/', {});
    assert.ok([302, 303].includes(res.status));

    const fresh = await db.TimeCorrection.findByPk(correction.id);
    assert.strictEqual(fresh.status, 'pending', 'the other company is out of reach');
    assert.strictEqual(fresh.selfApproved, false);
  });

  it('6. the administrative self-approval does not apply an invalid temporal correction', async () => {
    const s = await setupCompany();
    const ownerUser = await db.User.findByPk(s.owner.user.id);

    // (a) The invalid value is refused when the request is created, for
    //     everybody (the administrative exception relaxes nothing).
    const entry = await seedSession({
      companyId: s.companyId, userId: ownerUser.id,
      startedAt: localAt(3, '09:17'), endedAt: localAt(3, '17:03'),
    });
    await assert.rejects(
      () => corrections.createRequest({
        models: db, actor: ownerUser, type: 'entry_start', entryId: entry.id,
        input: { date: localDate(3), time: '25:00', reason: 'impossible hour' },
        timezone: TZ,
      }),
      /not a valid date and time/i
    );
    assert.strictEqual(
      await db.TimeCorrection.count({ where: { userId: ownerUser.id } }), 0
    );

    // (b) The session changes after the request was created: the proposed
    //     clock-in is no longer temporally valid, so nothing is applied.
    //     Another day is used so that the session of (a) does not overlap.
    const { entry: entry2, correction } = await requestOf(s, ownerUser, s.ownerAg, { daysAgo: 5, time: '10:00' });
    assert.ok(correction, 'the request was created');
    // The existing session remains valid, while its new end precedes the proposed start.
    await db.TimeEntry.update({ endedAt: localAt(5, '09:30') }, { where: { id: entry2.id } });

    const result = await corrections.resolveRequest({
      models: db, actor: ownerUser, correctionId: correction.id, decision: 'approve',
    });
    assert.strictEqual(result.status, 'conflict', 'the invalid correction is not applied');
    assert.ok(result.conflict);

    const fresh = await db.TimeCorrection.findByPk(correction.id);
    assert.strictEqual(fresh.status, 'conflict');
    assert.ok(fresh.conflictReason);
    assert.strictEqual(fresh.selfApproved, true, 'the decision is recorded anyway');

    const entryAfter = await db.TimeEntry.findByPk(entry2.id);
    assert.strictEqual(
      moment.utc(entryAfter.startedAt).tz(TZ).format('HH:mm'), '09:17',
      'the effective session was not touched'
    );
    assert.strictEqual(
      await db.TimeEntryEvent.count({ where: { timeEntryId: entry2.id, type: 'correction' } }), 0
    );
  });

  it('7. two concurrent self-approvals: only one is applied', async () => {
    const s = await setupCompany();
    const ownerUser = await db.User.findByPk(s.owner.user.id);
    const { correction } = await requestOf(s, ownerUser, s.ownerAg);

    const results = await Promise.allSettled([
      corrections.resolveRequest({
        models: db, actor: ownerUser, correctionId: correction.id, decision: 'approve',
      }),
      corrections.resolveRequest({
        models: db, actor: ownerUser, correctionId: correction.id, decision: 'approve',
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    assert.strictEqual(fulfilled.length, 1, 'exactly one self-approval succeeded');

    const fresh = await db.TimeCorrection.findByPk(correction.id);
    assert.strictEqual(fresh.status, 'applied');
    assert.strictEqual(
      await db.TimeEntryEvent.count({
        where: { timeEntryId: correction.timeEntryId, type: 'correction' },
      }),
      1, 'the correction was applied exactly once'
    );
  });

  it('8. the administrative self-approval with a version conflict is preserved, not applied', async () => {
    const s = await setupCompany();
    const ownerUser = await db.User.findByPk(s.owner.user.id);
    const { entry, correction } = await requestOf(s, ownerUser, s.ownerAg);

    // The session changes after the request was created: the snapshot of the
    // corrected value no longer matches the effective value.
    await db.TimeEntry.update(
      { startedAt: localAt(3, '09:40'), version: 2 },
      { where: { id: entry.id } }
    );

    const result = await corrections.resolveRequest({
      models: db, actor: ownerUser, correctionId: correction.id, decision: 'approve',
    });
    assert.strictEqual(result.status, 'conflict');
    assert.ok(/changed after this request was created/i.test(result.conflict));

    const fresh = await db.TimeCorrection.findByPk(correction.id);
    assert.strictEqual(fresh.status, 'conflict', 'the request is preserved for a human');
    assert.strictEqual(fresh.selfApproved, true, 'the decision is recorded anyway');
    assert.ok(fresh.conflictReason);

    const entryAfter = await db.TimeEntry.findByPk(entry.id);
    assert.strictEqual(
      moment.utc(entryAfter.startedAt).tz(TZ).format('HH:mm'), '09:40',
      'the effective session was not touched'
    );
    assert.strictEqual(
      await db.TimeEntryEvent.count({ where: { timeEntryId: entry.id, type: 'correction' } }), 0
    );
  });

  it('9. the administrative self-approval is audited explicitly', async () => {
    const s = await setupCompany();
    const ownerUser = await db.User.findByPk(s.owner.user.id);
    const { entry, correction } = await requestOf(s, ownerUser, s.ownerAg);

    await postForm(s.ownerAg, '/time/approvals/' + correction.id + '/approve/', {});

    const rows = await db.Audit.findAll({
      where: { entityType: 'TIME_CORRECTION', entityId: correction.id },
    });
    const attr = (name) => rows.find((r) => r.attribute === name);

    const flag = attr('administrative_self_approval');
    assert.ok(flag, 'there is an explicit audit row for the exception');
    assert.strictEqual(flag.oldValue, null);
    const payload = JSON.parse(flag.newValue);
    assert.strictEqual(payload.selfApproved, true);
    assert.strictEqual(String(payload.resolvedById), String(ownerUser.id));
    assert.strictEqual(payload.role, 'owner');
    assert.strictEqual(payload.policy, 'approval_required');

    // The rest of the trail is still complete: original value, proposed value,
    // reason and the approver.
    assert.ok(attr('original_value'), 'the original value is audited');
    assert.ok(attr('proposed_value'), 'the proposed value is audited');
    assert.strictEqual(attr('reason').newValue, 'forgot to clock in');
    assert.strictEqual(attr('resolved_by').newValue, String(ownerUser.id));
    assert.strictEqual(attr('status').newValue, 'applied');

    // The correction event of the timeline carries the flag too.
    const event = await db.TimeEntryEvent.findOne({
      where: { timeEntryId: entry.id, type: 'correction' },
    });
    const eventPayload = JSON.parse(event.payload);
    assert.strictEqual(eventPayload.administrativeSelfApproval, true);
    assert.strictEqual(eventPayload.requestedBy, ownerUser.id);
    assert.strictEqual(eventPayload.resolvedBy, ownerUser.id);
    assert.strictEqual(eventPayload.reason, 'forgot to clock in');
  });

  it('10. the self_service mode is not changed at all', async () => {
    const s = await setupCompany();
    await corrections.setPolicy({ models: db, companyId: s.companyId, mode: 'self_service' });

    const ownerUser = await db.User.findByPk(s.owner.user.id);
    const { entry, correction } = await requestOf(s, ownerUser, s.ownerAg);

    // It is applied when it is requested: there is no approval at all.
    const fresh = await db.TimeCorrection.findByPk(correction.id);
    assert.strictEqual(fresh.status, 'applied');
    assert.strictEqual(
      fresh.selfApproved, false, 'a self-service correction is not an approval'
    );
    assert.strictEqual(String(fresh.resolvedById), String(ownerUser.id));

    const rows = await db.Audit.findAll({
      where: { entityType: 'TIME_CORRECTION', entityId: correction.id },
    });
    assert.ok(
      !rows.find((r) => r.attribute === 'administrative_self_approval'),
      'no administrative self-approval is written in self-service mode'
    );

    const event = await db.TimeEntryEvent.findOne({
      where: { timeEntryId: entry.id, type: 'correction' },
    });
    assert.strictEqual(JSON.parse(event.payload).administrativeSelfApproval, false);
  });

  it('11. the pending requests that already exist remain resolvable', async () => {
    const s = await setupCompany();

    // (a) A pending request of an ordinary employee: the supervisor still
    //     resolves it exactly as before.
    const empUser = await db.User.findByPk(s.emp.user.id);
    const { correction } = await requestOf(s, empUser, s.empAg);
    assert.strictEqual(correction.status, 'pending');
    assert.strictEqual(correction.selfApproved, false);

    const res = await postForm(s.supAg, '/time/approvals/' + correction.id + '/approve/', {});
    assert.ok([302, 303].includes(res.status));

    const applied = await db.TimeCorrection.findByPk(correction.id);
    assert.strictEqual(applied.status, 'applied');
    assert.strictEqual(
      applied.selfApproved, false, 'a supervisor approval is not a self-approval'
    );
    assert.strictEqual(String(applied.resolvedById), String(s.sup.user.id));

    // (b) A pending request of the owner: it can be resolved with the new rule.
    const ownerUser = await db.User.findByPk(s.owner.user.id);
    const { correction: own } = await requestOf(s, ownerUser, s.ownerAg);
    assert.strictEqual(own.status, 'pending');

    const res2 = await postForm(s.ownerAg, '/time/approvals/' + own.id + '/approve/', {});
    assert.ok([302, 303].includes(res2.status));

    const ownApplied = await db.TimeCorrection.findByPk(own.id);
    assert.strictEqual(ownApplied.status, 'applied');
    assert.strictEqual(ownApplied.selfApproved, true);

    // (c) A request that is already resolved is never touched again.
    const again = await postForm(s.ownerAg, '/time/approvals/' + own.id + '/approve/', {});
    assert.ok([302, 303].includes(again.status));

    const unchanged = await db.TimeCorrection.findByPk(own.id);
    assert.strictEqual(unchanged.status, 'applied');
    assert.strictEqual(
      await db.TimeEntryEvent.count({
        where: { timeEntryId: own.timeEntryId, type: 'correction' },
      }),
      1, 'the correction was applied exactly once'
    );
  });

  it('12. the CSRF and the authorisation at service level are enforced', async () => {
    const s = await setupCompany();
    const ownerUser = await db.User.findByPk(s.owner.user.id);
    const { correction } = await requestOf(s, ownerUser, s.ownerAg);

    // Without a CSRF token the approval does not even reach the service.
    const res = await s.ownerAg.post('/time/approvals/' + correction.id + '/approve/')
      .type('form').send({});
    assert.strictEqual(res.status, 403);

    const untouched = await db.TimeCorrection.findByPk(correction.id);
    assert.strictEqual(untouched.status, 'pending');
    assert.strictEqual(untouched.selfApproved, false);

    // At service level the authorisation is exactly the one the route uses.
    const otherAdminAg = agent();
    const other = await registerAdmin(otherAdminAg);
    const otherUser = await db.User.findByPk(other.user.id);
    await assert.rejects(
      () => corrections.resolveRequest({
        models: db, actor: otherUser, correctionId: correction.id, decision: 'approve',
      }),
      /Unknown correction request/i
    );

    const empUser = await db.User.findByPk(s.emp.user.id);
    await assert.rejects(
      () => corrections.resolveRequest({
        models: db, actor: empUser, correctionId: correction.id, decision: 'approve',
      }),
      /not allowed to resolve/i
    );

    // And never on their own request either.
    const { correction: own } = await requestOf(s, empUser, s.empAg, { daysAgo: 7 });
    assert.ok(own, 'the request of the employee was created');
    await assert.rejects(
      () => corrections.resolveRequest({
        models: db, actor: empUser, correctionId: own.id, decision: 'approve',
      }),
      /cannot resolve your own/i
    );

    const stillPending = await db.TimeCorrection.findByPk(correction.id);
    assert.strictEqual(stillPending.status, 'pending');
    assert.strictEqual(stillPending.selfApproved, false);

    const ownPending = await db.TimeCorrection.findByPk(own.id);
    assert.strictEqual(ownPending.status, 'pending');
    assert.strictEqual(ownPending.selfApproved, false);
  });
});
