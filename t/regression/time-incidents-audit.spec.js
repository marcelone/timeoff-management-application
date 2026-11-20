'use strict';

/*
 * Time tracking — block 4: audit trail, concurrency and authorisation at the
 * service level.
 *
 * These checks complement t/regression/time-incidents.spec.js:
 *   - every action leaves its own audit rows, with who, what, when and the
 *     previous and the new state;
 *   - the audit trail is append-only: nothing rewrites an existing row;
 *   - two resolutions cannot both win, and a dismissal racing a resolution
 *     leaves exactly one closing;
 *   - a message or a link racing the closing is either stored before it or
 *     refused, never stored after it;
 *   - a double submission under real parallelism creates one incident;
 *   - the authorisation is decided by the SERVICE, so a caller that bypasses the
 *     routes gets exactly the same answer;
 *   - a failure while writing the audit rolls the whole decision back.
 */

const assert = require('assert');
const moment = require('moment-timezone');
const H = require('./helper');
const { agent, db, registerAdmin, addEmployee, login } = H;

const incidents = require('../../lib/modules/time/incidents');
const corrections = require('../../lib/modules/time/corrections');

const TZ = 'Europe/Madrid';

function localDate(daysAgo) {
  return moment.utc().subtract(daysAgo, 'days').format('YYYY-MM-DD');
}

async function userRow(user) {
  return db.User.findByPk(user.id);
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

async function openIncident(s, overrides = {}) {
  return incidents.createIncident({
    models: db, actor: await userRow(s.emp.user), timezone: TZ,
    input: Object.assign({
      type: 'clocking_problem',
      title: 'Default incident',
      description: 'A situation that needs a decision.',
      local_date: localDate(1),
    }, overrides),
  });
}

function auditRows(incidentId) {
  return db.Audit.findAll({
    where: { entityType: 'TIME_INCIDENT', entityId: incidentId },
    order: [['id', 'ASC']],
  });
}

describe('time tracking — block 4 (audit, concurrency, service authorisation)', function () {

  after(async () => {
    await db.TimeIncidentEntry.destroy({ where: {} });
    await db.TimeIncident.destroy({ where: {} });
    await db.Audit.destroy({ where: { entityType: 'TIME_INCIDENT' } });
  });

  // -------------------------------------------------------------------------
  describe('audit trail of every action', () => {
    it('records the creation with its content and the reference', async () => {
      const s = await setupCompany();
      const created = await openIncident(s, {
        type: 'schedule_discrepancy', title: 'Hours', local_date: localDate(2),
      });

      const rows = await auditRows(created.incident.id);
      const byAttr = (name) => rows.find((r) => r.attribute === name);

      assert.strictEqual(byAttr('status').oldValue, null);
      assert.strictEqual(byAttr('status').newValue, 'open');
      assert.strictEqual(byAttr('type').newValue, 'schedule_discrepancy');
      assert.strictEqual(byAttr('title').newValue, 'Hours');
      assert.strictEqual(byAttr('local_date').newValue, localDate(2));
      assert.ok(byAttr('description'));
      rows.forEach((r) => {
        assert.strictEqual(String(r.byUserId), String(s.emp.user.id), 'who acted');
        assert.strictEqual(r.companyId, s.companyId);
        assert.ok(r.at, 'when');
      });
    });

    it('records a message and does not rewrite the earlier rows', async () => {
      const s = await setupCompany();
      const created = await openIncident(s);
      const before = await auditRows(created.incident.id);

      await incidents.addComment({
        models: db, actor: await userRow(s.emp.user),
        incidentId: created.incident.id, body: 'A clarification.',
      });

      const after = await auditRows(created.incident.id);
      assert.ok(after.length > before.length, 'the trail grew');

      before.forEach((old, index) => {
        assert.strictEqual(after[index].id, old.id);
        assert.strictEqual(after[index].attribute, old.attribute);
        assert.strictEqual(after[index].newValue, old.newValue, 'the old row is untouched');
        assert.strictEqual(after[index].oldValue, old.oldValue);
      });

      const activity = after[after.length - 1];
      assert.strictEqual(activity.attribute, 'activity');
      const payload = JSON.parse(activity.newValue);
      assert.strictEqual(payload.kind, 'comment');
      assert.ok(payload.entryId, 'the entry is referenced');
      assert.ok(payload.length > 0);

      const entry = await db.TimeIncidentEntry.findByPk(payload.entryId);
      assert.ok(entry, 'the referenced entry exists');
      assert.strictEqual(entry.body, 'A clarification.');
    });

    it('records taking the incident into review', async () => {
      const s = await setupCompany();
      const created = await openIncident(s);

      await incidents.startReview({
        models: db, actor: await userRow(s.sup.user), incidentId: created.incident.id,
      });

      const rows = await auditRows(created.incident.id);
      const status = rows.find((r) => r.attribute === 'status' && r.newValue === 'in_review');
      assert.ok(status, 'the transition is audited');
      assert.strictEqual(status.oldValue, 'open');
      assert.ok(rows.find((r) => r.attribute === 'review_started_at'));
      assert.strictEqual(String(status.byUserId), String(s.sup.user.id), 'who took it');
    });

    it('records the resolution with the answer and the resolver', async () => {
      const s = await setupCompany();
      const created = await openIncident(s);

      await incidents.resolveIncident({
        models: db, actor: await userRow(s.sup.user), incidentId: created.incident.id,
        response: 'Verified with the platform log.',
      });

      const rows = await auditRows(created.incident.id);
      const status = rows.find((r) => r.attribute === 'status' && r.newValue === 'resolved');
      assert.strictEqual(status.oldValue, 'open');
      assert.strictEqual(
        rows.find((r) => r.attribute === 'resolution').newValue,
        'Verified with the platform log.'
      );
      assert.strictEqual(
        String(rows.find((r) => r.attribute === 'resolved_by').newValue),
        String(s.sup.user.id)
      );
      assert.ok(
        !rows.find((r) => r.attribute === 'administrative_self_resolution'),
        'a normal resolution is not flagged as an administrative one'
      );
    });

    it('records the dismissal and its reason', async () => {
      const s = await setupCompany();
      const created = await openIncident(s);

      await incidents.dismissIncident({
        models: db, actor: await userRow(s.sup.user), incidentId: created.incident.id,
        reason: 'Out of scope for the work-time register.',
      });

      const rows = await auditRows(created.incident.id);
      const status = rows.find((r) => r.attribute === 'status' && r.newValue === 'dismissed');
      assert.ok(status);
      assert.strictEqual(
        rows.find((r) => r.attribute === 'resolution').newValue,
        'Out of scope for the work-time register.'
      );
    });

    it('records the link with a correction, with the previous value', async () => {
      const s = await setupCompany();
      const date = localDate(3);
      const startedAt = moment.tz(`${date} 09:00`, 'YYYY-MM-DD HH:mm', TZ).toDate();
      const entry = await db.TimeEntry.create({
        companyId: s.companyId, userId: s.emp.user.id, modality: 'office',
        status: 'closed', source: 'direct', version: 1,
        startedAt, endedAt: moment.tz(`${date} 17:00`, 'YYYY-MM-DD HH:mm', TZ).toDate(),
      });
      const correction = await corrections.createRequest({
        models: db, actor: await userRow(s.emp.user), type: 'entry_start', entryId: entry.id,
        input: { date, time: '08:30', reason: 'forgot to clock in' }, timezone: TZ,
      });

      const created = await openIncident(s);
      await incidents.linkCorrection({
        models: db, actor: await userRow(s.emp.user),
        incidentId: created.incident.id, correctionId: correction.correction.id,
      });

      const rows = await auditRows(created.incident.id);
      const link = rows.find((r) => r.attribute === 'time_correction_id');
      assert.ok(link);
      assert.strictEqual(link.oldValue, null);
      assert.strictEqual(link.newValue, String(correction.correction.id));
    });

    it('the trail keeps one status row per transition and never overwrites it', async () => {
      const s = await setupCompany();
      const created = await openIncident(s);
      const supUser = await userRow(s.sup.user);

      await incidents.startReview({
        models: db, actor: supUser, incidentId: created.incident.id,
      });
      await incidents.resolveIncident({
        models: db, actor: supUser, incidentId: created.incident.id, response: 'Done.',
      });

      const rows = await auditRows(created.incident.id);
      const statusRows = rows.filter((r) => r.attribute === 'status');
      assert.deepStrictEqual(
        statusRows.map((r) => r.oldValue + '->' + r.newValue),
        ['null->open', 'open->in_review', 'in_review->resolved'],
        'every transition is preserved as its own row'
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('concurrency', () => {
    it('two concurrent resolutions: exactly one wins', async () => {
      const s = await setupCompany();
      const created = await openIncident(s);
      const supUser = await userRow(s.sup.user);

      const outcomes = await Promise.allSettled([
        incidents.resolveIncident({
          models: db, actor: supUser, incidentId: created.incident.id, response: 'First.',
        }),
        incidents.resolveIncident({
          models: db, actor: supUser, incidentId: created.incident.id, response: 'Second.',
        }),
      ]);

      assert.strictEqual(
        outcomes.filter((o) => o.status === 'fulfilled').length, 1,
        'exactly one resolution succeeded'
      );

      const fresh = await db.TimeIncident.findByPk(created.incident.id);
      assert.ok(['First.', 'Second.'].includes(fresh.resolution));

      assert.strictEqual(
        await db.TimeIncidentEntry.count({
          where: { incidentId: created.incident.id, kind: 'resolved' },
        }),
        1, 'exactly one closing entry'
      );

      const rows = await auditRows(created.incident.id);
      assert.strictEqual(
        rows.filter((r) => r.attribute === 'status' && r.newValue === 'resolved').length,
        1, 'exactly one audited transition'
      );
    });

    it('a resolution and a dismissal started together leave one closing', async () => {
      const s = await setupCompany();
      const created = await openIncident(s);
      const supUser = await userRow(s.sup.user);

      const outcomes = await Promise.allSettled([
        incidents.dismissIncident({
          models: db, actor: supUser, incidentId: created.incident.id, reason: 'Dismissed.',
        }),
        incidents.resolveIncident({
          models: db, actor: supUser, incidentId: created.incident.id, response: 'Resolved.',
        }),
      ]);

      assert.strictEqual(outcomes.filter((o) => o.status === 'fulfilled').length, 1);

      const finals = await db.TimeIncidentEntry.findAll({
        where: { incidentId: created.incident.id },
        order: [['id', 'ASC']],
      });
      const closing = finals.filter((e) => e.kind === 'resolved' || e.kind === 'dismissed');
      assert.strictEqual(closing.length, 1);
    });

    it('a message racing the closing is never stored after it', async () => {
      const s = await setupCompany();
      const created = await openIncident(s);
      const empUser = await userRow(s.emp.user);
      const supUser = await userRow(s.sup.user);

      const outcomes = await Promise.allSettled([
        incidents.addComment({
          models: db, actor: empUser, incidentId: created.incident.id, body: 'One more detail.',
        }),
        incidents.dismissIncident({
          models: db, actor: supUser, incidentId: created.incident.id, reason: 'Closed now.',
        }),
      ]);

      assert.strictEqual(outcomes[1].status, 'fulfilled', 'the decision completes');

      const entries = await db.TimeIncidentEntry.findAll({
        where: { incidentId: created.incident.id }, order: [['id', 'ASC']],
      });
      const closing = entries.find((e) => e.kind === 'dismissed');
      assert.ok(closing);

      if (outcomes[0].status === 'fulfilled') {
        const comment = entries.find((e) => e.kind === 'comment');
        assert.ok(comment, 'the message was stored');
        assert.ok(comment.id < closing.id, 'and it is before the closing');
      } else {
        assert.ok(/closed|no more messages/i.test(outcomes[0].reason.message));
        assert.strictEqual(entries.filter((e) => e.kind === 'comment').length, 0);
      }
    });

    it('a link racing the closing is either before it or refused', async () => {
      const s = await setupCompany();
      const date = localDate(3);
      const entry = await db.TimeEntry.create({
        companyId: s.companyId, userId: s.emp.user.id, modality: 'office',
        status: 'closed', source: 'direct', version: 1,
        startedAt: moment.tz(`${date} 09:00`, 'YYYY-MM-DD HH:mm', TZ).toDate(),
        endedAt: moment.tz(`${date} 17:00`, 'YYYY-MM-DD HH:mm', TZ).toDate(),
      });
      const correction = await corrections.createRequest({
        models: db, actor: await userRow(s.emp.user), type: 'entry_start', entryId: entry.id,
        input: { date, time: '08:30', reason: 'forgot to clock in' }, timezone: TZ,
      });
      const created = await openIncident(s);
      const empUser = await userRow(s.emp.user);
      const supUser = await userRow(s.sup.user);

      const outcomes = await Promise.allSettled([
        incidents.linkCorrection({
          models: db, actor: empUser, incidentId: created.incident.id,
          correctionId: correction.correction.id,
        }),
        incidents.resolveIncident({
          models: db, actor: supUser, incidentId: created.incident.id, response: 'Resolved.',
        }),
      ]);

      assert.strictEqual(outcomes[1].status, 'fulfilled');

      const fresh = await db.TimeIncident.findByPk(created.incident.id);
      assert.strictEqual(fresh.status, 'resolved');

      const entries = await db.TimeIncidentEntry.findAll({
        where: { incidentId: created.incident.id }, order: [['id', 'ASC']],
      });
      const closing = entries.find((e) => e.kind === 'resolved');
      const link = entries.find((e) => e.kind === 'link');

      if (outcomes[0].status === 'fulfilled') {
        assert.ok(link, 'the link was stored');
        assert.ok(link.id < closing.id, 'and it is before the closing');
        assert.strictEqual(String(fresh.timeCorrectionId), String(correction.correction.id));
      } else {
        assert.ok(/closed|cannot be linked/i.test(outcomes[0].reason.message));
        assert.strictEqual(link, undefined);
        assert.strictEqual(fresh.timeCorrectionId, null);
      }
    });

    it('two parallel submissions with the same token create one incident', async () => {
      const s = await setupCompany();
      const empUser = await userRow(s.emp.user);
      const token = 'parallel-' + Math.random().toString(36).slice(2, 12);

      const input = {
        type: 'other', title: 'Double click', description: 'Submitted twice at once.',
        local_date: localDate(1), idempotency_key: token,
      };

      const outcomes = await Promise.allSettled([
        incidents.createIncident({ models: db, actor: empUser, input, timezone: TZ }),
        incidents.createIncident({ models: db, actor: empUser, input, timezone: TZ }),
      ]);

      assert.ok(
        outcomes.some((o) => o.status === 'fulfilled'),
        'at least one submission completes'
      );
      assert.strictEqual(
        await db.TimeIncident.count({ where: { userId: s.emp.user.id } }), 1,
        'exactly one incident exists'
      );

      const row = await db.TimeIncident.findOne({ where: { userId: s.emp.user.id } });
      assert.strictEqual(row.idempotencyKey, token);
    });
  });

  // -------------------------------------------------------------------------
  describe('authorisation at the service level', () => {
    it('another company cannot read, decide, comment or link', async () => {
      const s = await setupCompany();
      const created = await openIncident(s);

      const otherAg = agent();
      const other = await registerAdmin(otherAg, { company: 'Bypass Co' });
      const otherUser = await userRow(other.user);

      await assert.rejects(
        async () => incidents.getForActor({
          models: db, actor: otherUser, incidentId: created.incident.id,
        }),
        /Unknown incident/i
      );
      await assert.rejects(
        async () => incidents.startReview({
          models: db, actor: otherUser, incidentId: created.incident.id,
        }),
        /Unknown incident/i
      );
      await assert.rejects(
        async () => incidents.resolveIncident({
          models: db, actor: otherUser, incidentId: created.incident.id, response: 'Hijacked.',
        }),
        /Unknown incident/i
      );
      await assert.rejects(
        async () => incidents.dismissIncident({
          models: db, actor: otherUser, incidentId: created.incident.id, reason: 'Hijacked.',
        }),
        /Unknown incident/i
      );
      await assert.rejects(
        async () => incidents.addComment({
          models: db, actor: otherUser, incidentId: created.incident.id, body: 'Hijacked.',
        }),
        /Unknown incident/i
      );
      await assert.rejects(
        async () => incidents.linkCorrection({
          models: db, actor: otherUser, incidentId: created.incident.id, correctionId: '1',
        }),
        /Unknown incident/i
      );

      const fresh = await db.TimeIncident.findByPk(created.incident.id);
      assert.strictEqual(fresh.status, 'open');
      assert.strictEqual(
        await db.TimeIncidentEntry.count({ where: { incidentId: created.incident.id } }), 0
      );
    });

    it('the canView and canManage answers match what the service does', async () => {
      const s = await setupCompany();
      const created = await openIncident(s);

      const empUser = await userRow(s.emp.user);
      const supUser = await userRow(s.sup.user);
      const adminUser = await userRow(s.admin);

      assert.strictEqual(
        await incidents.canView({ models: db, actor: empUser, incident: created.incident }), true
      );
      assert.strictEqual(
        await incidents.canManage({ models: db, actor: empUser, incident: created.incident }), false,
        'the requester cannot decide on their own ordinary incident'
      );
      assert.strictEqual(
        await incidents.canManage({ models: db, actor: supUser, incident: created.incident }), true
      );
      assert.strictEqual(
        await incidents.canManage({ models: db, actor: adminUser, incident: created.incident }), true
      );
    });

    it('only the requester can link a correction', async () => {
      const s = await setupCompany();
      const date = localDate(3);
      const entry = await db.TimeEntry.create({
        companyId: s.companyId, userId: s.emp.user.id, modality: 'office',
        status: 'closed', source: 'direct', version: 1,
        startedAt: moment.tz(`${date} 09:00`, 'YYYY-MM-DD HH:mm', TZ).toDate(),
        endedAt: moment.tz(`${date} 17:00`, 'YYYY-MM-DD HH:mm', TZ).toDate(),
      });
      const correction = await corrections.createRequest({
        models: db, actor: await userRow(s.emp.user), type: 'entry_start', entryId: entry.id,
        input: { date, time: '08:30', reason: 'forgot to clock in' }, timezone: TZ,
      });
      const created = await openIncident(s);

      // The supervisor may decide, but the reference belongs to the employee.
      await assert.rejects(
        async () => incidents.linkCorrection({
          models: db, actor: await userRow(s.sup.user),
          incidentId: created.incident.id, correctionId: correction.correction.id,
        }),
        /only the requester/i
      );

      const fresh = await db.TimeIncident.findByPk(created.incident.id);
      assert.strictEqual(fresh.timeCorrectionId, null);
    });

    it('a correction of another employee of the same company cannot be linked', async () => {
      const s = await setupCompany();
      const date = localDate(3);
      const entry = await db.TimeEntry.create({
        companyId: s.companyId, userId: s.sup.user.id, modality: 'office',
        status: 'closed', source: 'direct', version: 1,
        startedAt: moment.tz(`${date} 09:00`, 'YYYY-MM-DD HH:mm', TZ).toDate(),
        endedAt: moment.tz(`${date} 17:00`, 'YYYY-MM-DD HH:mm', TZ).toDate(),
      });
      const foreignCorrection = await corrections.createRequest({
        models: db, actor: await userRow(s.sup.user), type: 'entry_start', entryId: entry.id,
        input: { date, time: '08:30', reason: 'supervisor correction' }, timezone: TZ,
      });
      const created = await openIncident(s);

      await assert.rejects(
        async () => incidents.linkCorrection({
          models: db, actor: await userRow(s.emp.user),
          incidentId: created.incident.id, correctionId: foreignCorrection.correction.id,
        }),
        /Unknown correction request/i
      );
    });
  });

  // -------------------------------------------------------------------------
  // Regressions of the post-audit defects. Each one reproduces the exact
  // scenario the audit reported, so it cannot come back unnoticed.
  // -------------------------------------------------------------------------
  describe('revalidation of the actor, coherent instants, real counters', () => {
    it('a revoked administrator cannot decide on a stale instance anymore', async () => {
      const s = await setupCompany();
      const adminUser = await userRow(s.admin);

      // The administrator files an incident of their own.
      const created = await incidents.createIncident({
        models: db, actor: adminUser, timezone: TZ,
        input: {
          type: 'other', title: 'Mine as admin',
          description: 'Administrative self-resolution attempt.', local_date: localDate(2),
        },
      });

      // The STALE instance: loaded before the revocation, still admin = true.
      const staleActor = await db.User.findByPk(s.admin.id);
      assert.strictEqual(staleActor.admin, true, 'the stale instance still looks like an admin');

      // The permissions are revoked in the database.
      await db.sequelize.query('UPDATE "Users" SET "admin" = 0, "role" = ? WHERE "id" = ?', {
        replacements: ['employee', s.admin.id],
      });
      const reloaded = await db.User.findByPk(s.admin.id);
      assert.strictEqual(reloaded.admin, false, 'the revocation is stored');

      // With the stale instance the decision must be refused anyway.
      await assert.rejects(
        () => incidents.resolveIncident({
          models: db, actor: staleActor, incidentId: created.incident.id,
          response: 'Should never be accepted.',
        }),
        /not allowed/i,
        'a stale administrative instance cannot self-resolve after a revocation'
      );

      const fresh = await db.TimeIncident.findByPk(created.incident.id);
      assert.strictEqual(fresh.status, 'open', 'the incident is untouched');
      assert.strictEqual(fresh.selfResolved, false);
      assert.strictEqual(fresh.resolution, null);
      assert.strictEqual(
        await db.TimeIncidentEntry.count({ where: { incidentId: created.incident.id } }), 0
      );
    });

    it('a supervisor whose link was removed cannot decide on a stale instance', async () => {
      const s = await setupCompany();
      const employeeUser = await userRow(s.emp.user);

      // A secondary supervisor with the link, and a stale copy of them.
      const helper = await addEmployee(s.adminAg, s.companyId, {
        name: 'Help', lastname: 'Ervisor',
      });
      await db.DepartmentSupervisor.create({
        department_id: s.dept.id, user_id: helper.user.id,
      });
      const staleHelper = await db.User.findByPk(helper.user.id);

      const created = await incidents.createIncident({
        models: db, actor: employeeUser, timezone: TZ,
        input: {
          type: 'other', title: 'Before the revocation',
          description: 'The link is about to be removed.', local_date: localDate(2),
        },
      });

      assert.strictEqual(
        await incidents.canManage({
          models: db, actor: staleHelper, incident: created.incident,
        }),
        true, 'with the link the stale instance may decide'
      );

      await db.DepartmentSupervisor.destroy({
        where: { department_id: s.dept.id, user_id: helper.user.id },
      });

      await assert.rejects(
        () => incidents.resolveIncident({
          models: db, actor: staleHelper, incidentId: created.incident.id,
          response: 'Too late.',
        }),
        /not allowed/i,
        'the decision is re-evaluated against the database, not against the object'
      );

      const fresh = await db.TimeIncident.findByPk(created.incident.id);
      assert.strictEqual(fresh.status, 'open');
    });

    it('the closing instant is taken after the lock, so the thread keeps its order', async () => {
      const s = await setupCompany();
      const created = await openIncident(s);
      const empUser = await userRow(s.emp.user);
      const supUser = await userRow(s.sup.user);

      // Force the reported interleaving: the resolution is held BEFORE it takes
      // the lock, a message is committed meanwhile, and only then it proceeds.
      const originalTransaction = db.sequelize.transaction.bind(db.sequelize);
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      let gated = true;
      db.sequelize.transaction = async function (fn) {
        if (gated) { gated = false; await gate; }
        return originalTransaction(fn);
      };

      let resolution;
      try {
        resolution = incidents.resolveIncident({
          models: db, actor: supUser, incidentId: created.incident.id,
          response: 'Closing after the message.',
        });
        await Promise.resolve();

        // The message is stored first, with its own (later) instant.
        await incidents.addComment({
          models: db, actor: empUser, incidentId: created.incident.id,
          body: 'A clarification that arrives before the closing.',
        });

        release();
        await resolution;
      } finally {
        db.sequelize.transaction = originalTransaction;
      }

      const entries = await db.TimeIncidentEntry.findAll({
        where: { incidentId: created.incident.id },
        order: [['at', 'ASC'], ['id', 'ASC']],
      });
      assert.deepStrictEqual(entries.map((e) => e.kind), ['comment', 'resolved'],
        'the visible order follows the instants');

      const fresh = await db.TimeIncident.findByPk(created.incident.id);
      const commentEntry = entries[0];
      const resolvedEntry = entries[1];

      assert.ok(
        new Date(fresh.resolvedAt).getTime() >= new Date(commentEntry.at).getTime(),
        'the closing is never older than a message committed before it'
      );
      assert.ok(
        new Date(resolvedEntry.at).getTime() >= new Date(commentEntry.at).getTime(),
        'the closing entry is not older than the message'
      );
      assert.strictEqual(
        new Date(fresh.lastActivityAt).getTime(),
        new Date(resolvedEntry.at).getTime(),
        'lastActivityAt is the last activity, it never goes backwards'
      );
    });

    it('the pending counter counts the whole scope, it does not slice a page', async () => {
      const s = await setupCompany();
      const empUser = await userRow(s.emp.user);

      // A backlog of closed cases, older than the pending one.
      const base = new Date(Date.now() - 60 * 24 * 3600 * 1000);
      const rows = [];
      for (let i = 0; i < 105; i += 1) {
        rows.push({
          companyId: s.companyId,
          userId: s.emp.user.id,
          localDate: localDate(60),
          type: 'other',
          title: 'Closed backlog ' + i,
          description: 'Already closed.',
          status: 'resolved',
          openedAt: new Date(base.getTime() + i * 1000),
          reviewStartedAt: null,
          resolvedAt: new Date(base.getTime() + i * 1000 + 500),
          resolvedById: s.sup.user.id,
          resolution: 'Closed long ago.',
          selfResolved: false,
          lastActivityAt: new Date(base.getTime() + i * 1000 + 500),
        });
      }
      await db.TimeIncident.bulkCreate(rows);

      // One open case, and it is the newest.
      await incidents.createIncident({
        models: db, actor: empUser, timezone: TZ,
        input: {
          type: 'clocking_problem', title: 'Still pending',
          description: 'It must be counted.', local_date: localDate(1),
        },
      });

      const supUser = await userRow(s.sup.user);
      assert.strictEqual(
        await incidents.countPending({ models: db, actor: supUser }), 1,
        'the counter sees the pending one behind 105 closed rows'
      );

      // And the tray shows it first, even with the default filter.
      const tray = await incidents.listQueue({ models: db, actor: supUser });
      assert.strictEqual(tray[0].title, 'Still pending', 'pending incidents come first');

      // The employee list keeps its own counter at zero (no supervision scope).
      assert.strictEqual(
        await incidents.countPending({ models: db, actor: empUser }), 0
      );
    });

    it('the entry to the tray does not depend on the counter', async () => {
      const s = await setupCompany();

      // A supervisor with nothing pending at all.
      const res = await s.supAg.get('/time/incidents/');
      assert.strictEqual(res.status, 200);
      assert.ok(
        /\/time\/incidents\/queue\//.test(res.text),
        'the supervisor still sees the way to their tray'
      );

      // A plain employee has no tray at all.
      const empRes = await s.empAg.get('/time/incidents/');
      assert.strictEqual(empRes.status, 200);
      assert.ok(
        !/\/time\/incidents\/queue\//.test(empRes.text),
        'a plain employee is not offered a tray that would be empty'
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('atomicity', () => {
    it('a failure while writing the audit rolls the decision back', async () => {
      const s = await setupCompany();
      const created = await openIncident(s);
      const supUser = await userRow(s.sup.user);

      const original = db.Audit.create;
      db.Audit.create = async () => { throw new Error('simulated audit failure'); };
      let failed = false;
      try {
        await incidents.resolveIncident({
          models: db, actor: supUser, incidentId: created.incident.id,
          response: 'This must never be stored.',
        });
      } catch (e) {
        failed = true;
      } finally {
        db.Audit.create = original;
      }

      assert.ok(failed, 'the failure was propagated');

      const fresh = await db.TimeIncident.findByPk(created.incident.id);
      assert.strictEqual(fresh.status, 'open', 'the status was rolled back');
      assert.strictEqual(fresh.resolution, null);
      assert.strictEqual(fresh.resolvedAt, null);
      assert.strictEqual(fresh.resolvedById, null);
      assert.strictEqual(
        await db.TimeIncidentEntry.count({ where: { incidentId: created.incident.id } }), 0,
        'the entry of the failed decision was rolled back too'
      );
    });

    it('a failure while writing the thread rolls the creation back', async () => {
      const s = await setupCompany();
      const original = db.TimeIncident.create;
      db.TimeIncident.create = async () => { throw new Error('simulated failure'); };
      let failed = false;
      try {
        await openIncident(s, { title: 'Never stored' });
      } catch (e) {
        failed = true;
      } finally {
        db.TimeIncident.create = original;
      }

      assert.ok(failed);
      assert.strictEqual(
        await db.TimeIncident.count({ where: { title: 'Never stored' } }), 0
      );
      assert.strictEqual(
        await db.Audit.count({
          where: { entityType: 'TIME_INCIDENT', attribute: 'title', newValue: 'Never stored' },
        }),
        0, 'no orphan audit row'
      );
    });
  });
});