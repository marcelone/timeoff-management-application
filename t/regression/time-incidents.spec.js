'use strict';

/*
 * Time tracking — block 4: work-time incidents and employee self-service.
 *
 * Covers the required checks of the block-4 specification:
 *
 *   Creation       1-10   own incident, without/with a session, foreign session,
 *                          foreign company, invalid type, invalid date, empty
 *                          description, too-long title, double submission
 *   Authorisation 11-20   own/foreign read, supervisor scope, other department,
 *                          other company, RBAC manager alone, owner/admin,
 *                          supervisor self-decision refused, owner/admin
 *                          self-resolution audited, revoked link, department move
 *   Workflow      21-30   open->in_review, open->resolved, in_review->resolved,
 *                          dismissal with reason, answer required, double
 *                          resolution, concurrent resolve/dismiss, transition
 *                          from a final state, atomic status+audit, rollback
 *   Activity      31-37   clarification, answer, comment after closing, foreign
 *                          comment, chronological order, comment vs closing,
 *                          append-only thread
 *   Integration   38-45   own correction link, cross-company link, link does not
 *                          apply, conflict does not resolve, computation and
 *                          absences untouched, compatibility with blocks 1-3
 *   Security      46-54   CSRF, multipart, IDOR, mass assignment, HTML escaping,
 *                          async errors, service validation, DB restrictions,
 *                          multi-tenant isolation
 *   Compatibility 55-58   SQLite schema, indexes and foreign keys
 *
 * PostgreSQL 16 (56) and the browser flows (59-60) are verified in separate
 * runs, because this suite is hard-isolated to a throwaway SQLite database.
 */

const assert = require('assert');
const moment = require('moment-timezone');
const H = require('./helper');
const { agent, db, postForm, registerAdmin, addEmployee, login } = H;

const incidents = require('../../lib/modules/time/incidents');
const corrections = require('../../lib/modules/time/corrections');

const TZ = 'Europe/Madrid';

function localDate(daysAgo) {
  return moment.utc().subtract(daysAgo, 'days').format('YYYY-MM-DD');
}

async function userRow(user) {
  return db.User.findByPk(user.id);
}

/**
 * A company with an owner (RBAC role 'owner'), an administrator (admin = true),
 * a supervisor (boss of the department) and an ordinary employee. Everybody is
 * logged in with their own agent.
 */
async function setupCompany() {
  const adminAg = agent();
  const { user: admin } = await registerAdmin(adminAg);
  const companyId = admin.companyId;
  const dept = await db.Department.findOne({ where: { companyId } });

  const owner = await addEmployee(adminAg, companyId, { name: 'Own', lastname: 'Er' });
  const ownerUser = await db.User.findByPk(owner.user.id);
  ownerUser.role = 'owner';
  ownerUser.admin = false;
  await ownerUser.save();

  const sup = await addEmployee(adminAg, companyId, { name: 'Sup', lastname: 'Ervisor' });
  const emp = await addEmployee(adminAg, companyId, { name: 'Emp', lastname: 'Loyee' });

  dept.bossId = sup.user.id;
  await dept.save();

  const ownerAg = agent();
  await login(ownerAg, owner.email, owner.password);
  const supAg = agent();
  await login(supAg, sup.email, sup.password);
  const empAg = agent();
  await login(empAg, emp.email, emp.password);

  return { adminAg, admin, owner, companyId, dept, sup, emp, ownerAg, supAg, empAg };
}

/**
 * An employee of another department of the same company (no supervision link).
 * Created directly in the database: the tests only need the row, not a session.
 */
async function addOtherDepartmentEmployee(companyId) {
  const otherDept = await db.Department.create({
    name: 'Other-' + Math.random().toString(36).slice(2, 8), companyId,
  });
  const user = await db.User.create({
    email: `other-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
    password: 'x', name: 'Other', lastname: 'Dept',
    companyId, DepartmentId: otherDept.id, admin: false, activated: true,
    start_date: '2026-01-01',
  });
  return { otherDept, user };
}

/**
 * A colleague of the same department, created through the real route (so the
 * password is hashed) and logged in: used to prove that a peer has no access.
 */
async function addColleague(adminAg, companyId) {
  const colleague = await addEmployee(adminAg, companyId, { name: 'Coll', lastname: 'Eague' });
  const ag = agent();
  await login(ag, colleague.email, colleague.password);
  return { user: colleague.user, ag, email: colleague.email };
}

/** A closed session for the employee, with its original events. */
async function seedSession({ companyId, userId, daysAgo, start = '09:00', end = '17:00' }) {
  const date = localDate(daysAgo === undefined ? 3 : daysAgo);
  const startedAt = moment.tz(`${date} ${start}`, 'YYYY-MM-DD HH:mm', TZ).toDate();
  const endedAt = moment.tz(`${date} ${end}`, 'YYYY-MM-DD HH:mm', TZ).toDate();
  const entry = await db.TimeEntry.create({
    companyId, userId, modality: 'office', status: 'closed', source: 'direct', version: 1,
    startedAt, endedAt,
  });
  await db.TimeEntryEvent.create({
    companyId, userId, timeEntryId: entry.id, type: 'in',
    occurredAt: startedAt, source: 'direct', modality: 'office',
  });
  await db.TimeEntryEvent.create({
    companyId, userId, timeEntryId: entry.id, type: 'out',
    occurredAt: endedAt, source: 'direct', modality: 'office',
  });
  return entry;
}

/** File an incident through the real route. */
function fileIncident(ag, data) {
  const body = Object.assign({
    type: 'clocking_problem',
    local_date: localDate(1),
    title: 'The app was unavailable',
    description: 'From 08:00 to 09:00 the platform did not respond.',
    idempotency_key: 'token-' + Math.random().toString(36).slice(2, 12),
  }, data);
  return postForm(ag, '/time/incidents/', body);
}

describe('time tracking — block 4 (work-time incidents)', function () {

  // The suite shares one database. The thread references the incident, so it is
  // removed first, and the audit rows of this entity go with them.
  after(async () => {
    await db.TimeIncidentEntry.destroy({ where: {} });
    await db.TimeIncident.destroy({ where: {} });
    await db.Audit.destroy({ where: { entityType: 'TIME_INCIDENT' } });
  });

  // -------------------------------------------------------------------------
  describe('creation', () => {
    it('1. the employee files an incident of their own', async () => {
      const s = await setupCompany();
      const res = await fileIncident(s.empAg, {});

      assert.ok([302, 303].includes(res.status), 'the form redirects');

      const row = await db.TimeIncident.findOne({ where: { userId: s.emp.user.id } });
      assert.ok(row, 'the incident exists');
      assert.strictEqual(row.companyId, s.companyId);
      assert.strictEqual(row.status, 'open');
      assert.strictEqual(row.type, 'clocking_problem');
      assert.ok(row.openedAt, 'the opening instant is recorded');
      assert.ok(row.lastActivityAt, 'the last activity is recorded');
      assert.strictEqual(row.selfResolved, false);

      const audits = await db.Audit.findAll({
        where: { entityType: 'TIME_INCIDENT', entityId: row.id },
      });
      assert.ok(audits.length >= 5, 'the creation is audited');
      assert.ok(audits.find((a) => a.attribute === 'status').newValue === 'open');
    });

    it('2. an incident can exist with no work session at all', async () => {
      const s = await setupCompany();
      await fileIncident(s.empAg, { title: 'No session', description: 'Nothing was recorded.' });

      const row = await db.TimeIncident.findOne({ where: { userId: s.emp.user.id } });
      assert.strictEqual(row.timeEntryId, null, 'no session is required');
    });

    it('3. an incident can be attached to the employee own session', async () => {
      const s = await setupCompany();
      const entry = await seedSession({ companyId: s.companyId, userId: s.emp.user.id });

      await fileIncident(s.empAg, {
        title: 'The clock did not register',
        description: 'I clocked in but nothing appeared.',
        time_entry_id: String(entry.id),
      });

      const row = await db.TimeIncident.findOne({ where: { userId: s.emp.user.id } });
      assert.strictEqual(String(row.timeEntryId), String(entry.id));
    });

    it('4. the session of another employee is rejected', async () => {
      const s = await setupCompany();
      const entry = await seedSession({ companyId: s.companyId, userId: s.sup.user.id });

      const res = await fileIncident(s.empAg, {
        title: 'Wrong session', description: 'Trying to attach somebody else session.',
        time_entry_id: String(entry.id),
      });
      assert.ok([302, 303].includes(res.status));

      assert.strictEqual(
        await db.TimeIncident.count({ where: { userId: s.emp.user.id } }), 0,
        'no incident is created with a foreign session'
      );

      const page = await s.empAg.get('/time/incidents/');
      assert.ok(/does not exist/i.test(page.text), 'the reason is explained');
    });

    it('5. a session of another company is rejected', async () => {
      const s = await setupCompany();
      const otherAdminAg = agent();
      const other = await registerAdmin(otherAdminAg, { company: 'OtherCo' });
      const foreignEntry = await seedSession({
        companyId: other.user.companyId, userId: other.user.id,
      });

      await fileIncident(s.empAg, {
        title: 'Cross company', description: 'Trying to attach a session of another company.',
        time_entry_id: String(foreignEntry.id),
      });

      assert.strictEqual(await db.TimeIncident.count({ where: { userId: s.emp.user.id } }), 0);
      const untouched = await db.TimeEntry.findByPk(foreignEntry.id);
      assert.ok(untouched, 'the foreign session is untouched');
    });

    it('6. an unknown type is rejected', async () => {
      const s = await setupCompany();
      await fileIncident(s.empAg, { type: 'invented_type' });
      assert.strictEqual(await db.TimeIncident.count({ where: { userId: s.emp.user.id } }), 0);

      const empUser = await userRow(s.emp.user);
      await assert.rejects(
        async () => incidents.createIncident({
          models: db, actor: empUser, timezone: TZ,
          input: {
            type: 'invented_type', title: 'x', description: 'y', local_date: localDate(1),
          },
        }),
        /valid incident type/i
      );
    });

    it('7. an invalid or future date is rejected', async () => {
      const s = await setupCompany();
      const empUser = await userRow(s.emp.user);

      await assert.rejects(
        async () => incidents.createIncident({
          models: db, actor: empUser, timezone: TZ,
          input: {
            type: 'other', title: 'x', description: 'y', local_date: '2026-02-31',
          },
        }),
        /not a valid date/i
      );

      await assert.rejects(
        async () => incidents.createIncident({
          models: db, actor: empUser, timezone: TZ,
          input: {
            type: 'other', title: 'x', description: 'y',
            local_date: moment.utc().add(3, 'days').format('YYYY-MM-DD'),
          },
        }),
        /cannot be in the future/i
      );

      assert.strictEqual(await db.TimeIncident.count({ where: { userId: s.emp.user.id } }), 0);
    });

    it('8. an empty description is rejected', async () => {
      const s = await setupCompany();
      const empUser = await userRow(s.emp.user);

      await assert.rejects(
        async () => incidents.createIncident({
          models: db, actor: empUser, timezone: TZ,
          input: { type: 'other', title: 'A title', description: '   ', local_date: localDate(1) },
        }),
        /description is required/i
      );
      assert.strictEqual(await db.TimeIncident.count({ where: { userId: s.emp.user.id } }), 0);
    });

    it('9. an over-long title is rejected', async () => {
      const s = await setupCompany();
      const empUser = await userRow(s.emp.user);

      await assert.rejects(
        async () => incidents.createIncident({
          models: db, actor: empUser, timezone: TZ,
          input: {
            type: 'other',
            title: 'x'.repeat(incidents.LIMITS.TITLE + 1),
            description: 'A description',
            local_date: localDate(1),
          },
        }),
        /title is too long/i
      );
      assert.strictEqual(await db.TimeIncident.count({ where: { userId: s.emp.user.id } }), 0);
    });

    it('10. a double submission creates exactly one incident', async () => {
      const s = await setupCompany();
      const token = 'fixed-token-' + Math.random().toString(36).slice(2, 10);

      const first = await fileIncident(s.empAg, { idempotency_key: token });
      const second = await fileIncident(s.empAg, { idempotency_key: token });

      assert.ok([302, 303].includes(first.status));
      assert.ok([302, 303].includes(second.status));

      assert.strictEqual(
        await db.TimeIncident.count({ where: { userId: s.emp.user.id } }), 1,
        'the second submission returns the first incident'
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('authorisation', () => {
    it('11. the employee cannot read an incident of somebody else', async () => {
      const s = await setupCompany();
      const incident = await incidents.createIncident({
        models: db, actor: await userRow(s.sup.user), timezone: TZ,
        input: {
          type: 'other', title: 'Supervisor incident', description: 'Mine.',
          local_date: localDate(1),
        },
      });

      const res = await s.empAg.get('/time/incidents/' + incident.incident.id + '/');
      assert.ok([302, 303].includes(res.status), 'it is not rendered');

      const follow = await s.empAg.get('/time/incidents/');
      assert.ok(/Unknown incident/i.test(follow.text), 'the refusal is not a data leak');

      const empUser = await userRow(s.emp.user);
      await assert.rejects(
        async () => incidents.getForActor({
          models: db, actor: empUser, incidentId: incident.incident.id,
        }),
        /Unknown incident/i
      );
    });

    it('12. the supervisor reads the incidents of their department', async () => {
      const s = await setupCompany();
      const created = await incidents.createIncident({
        models: db, actor: await userRow(s.emp.user), timezone: TZ,
        input: {
          type: 'work_interruption', title: 'Power cut', description: 'Two hours without power.',
          local_date: localDate(1),
        },
      });

      const res = await s.supAg.get('/time/incidents/' + created.incident.id + '/');
      assert.strictEqual(res.status, 200);
      assert.ok(/Power cut/.test(res.text));
      assert.ok(/Two hours without power/.test(res.text));

      const supUser = await userRow(s.sup.user);
      const visible = await incidents.getForActor({
        models: db, actor: supUser, incidentId: created.incident.id,
      });
      assert.strictEqual(visible.id, created.incident.id);
    });

    it('13. the supervisor does not read another department', async () => {
      const s = await setupCompany();
      const foreign = await addOtherDepartmentEmployee(s.companyId);

      const created = await incidents.createIncident({
        models: db, actor: await userRow(foreign.user), timezone: TZ,
        input: {
          type: 'other', title: 'Other department', description: 'Not supervised.',
          local_date: localDate(1),
        },
      });

      const res = await s.supAg.get('/time/incidents/' + created.incident.id + '/');
      assert.ok([302, 303].includes(res.status), 'the page is not rendered');

      const supUser = await userRow(s.sup.user);
      await assert.rejects(
        async () => incidents.getForActor({
          models: db, actor: supUser, incidentId: created.incident.id,
        }),
        /Unknown incident/i
      );
    });

    it('14. a supervisor of another company reads nothing', async () => {
      const s = await setupCompany();
      const created = await incidents.createIncident({
        models: db, actor: await userRow(s.emp.user), timezone: TZ,
        input: {
          type: 'other', title: 'Scoped', description: 'Only my company.',
          local_date: localDate(1),
        },
      });

      const otherAdminAg = agent();
      const other = await registerAdmin(otherAdminAg, { company: 'Foreign' });
      const otherUser = await userRow(other.user);

      await assert.rejects(
        async () => incidents.getForActor({
          models: db, actor: otherUser, incidentId: created.incident.id,
        }),
        /Unknown incident/i
      );

      const list = await otherAdminAg.get('/time/incidents/queue/');
      assert.strictEqual(list.status, 200);
      assert.ok(!/Scoped/.test(list.text), 'the other company sees nothing');
    });

    it('15. the RBAC role manager alone grants nothing', async () => {
      const s = await setupCompany();
      const created = await incidents.createIncident({
        models: db, actor: await userRow(s.emp.user), timezone: TZ,
        input: {
          type: 'other', title: 'Manager test', description: 'No supervision link.',
          local_date: localDate(1),
        },
      });

      const manager = await addEmployee(s.adminAg, s.companyId, {
        name: 'Man', lastname: 'Ager',
      });
      const managerRow = await db.User.findByPk(manager.user.id);
      managerRow.role = 'manager';
      managerRow.admin = false;
      await managerRow.save();
      const managerUser = await userRow(manager.user);

      assert.strictEqual(
        await incidents.canView({
          models: db, actor: managerUser, incident: created.incident,
        }),
        false,
        'the role alone does not allow reading'
      );
      assert.strictEqual(
        await incidents.canManage({
          models: db, actor: managerUser, incident: created.incident,
        }),
        false,
        'the role alone does not allow deciding'
      );
      await assert.rejects(
        async () => incidents.resolveIncident({
          models: db, actor: managerUser, incidentId: created.incident.id,
          response: 'Not allowed.',
        }),
        /not allowed/i
      );
    });

    it('16. the owner/admin reads every incident of the company', async () => {
      const s = await setupCompany();
      const created = await incidents.createIncident({
        models: db, actor: await userRow(s.emp.user), timezone: TZ,
        input: {
          type: 'schedule_discrepancy', title: 'Hours do not add up',
          description: 'The computed hours look wrong.', local_date: localDate(1),
        },
      });

      const res = await s.adminAg.get('/time/incidents/' + created.incident.id + '/');
      assert.strictEqual(res.status, 200);
      assert.ok(/Hours do not add up/.test(res.text));

      const ownerUser = await userRow(s.owner.user);
      const visible = await incidents.getForActor({
        models: db, actor: ownerUser, incidentId: created.incident.id,
      });
      assert.strictEqual(visible.id, created.incident.id);
    });

    it('17. an ordinary supervisor cannot resolve their own incident', async () => {
      const s = await setupCompany();
      const created = await incidents.createIncident({
        models: db, actor: await userRow(s.sup.user), timezone: TZ,
        input: {
          type: 'other', title: 'Mine as supervisor', description: 'Self decision attempt.',
          local_date: localDate(1),
        },
      });

      const supUser = await userRow(s.sup.user);
      assert.strictEqual(
        await incidents.canManage({
          models: db, actor: supUser, incident: created.incident,
        }),
        false
      );

      await assert.rejects(
        async () => incidents.resolveIncident({
          models: db, actor: supUser, incidentId: created.incident.id, response: 'By me.',
        }),
        /not allowed/i
      );

      const res = await postForm(s.supAg, '/time/incidents/' + created.incident.id + '/resolve/', {
        resolution: 'By me.',
      });
      assert.ok([302, 303].includes(res.status));

      const fresh = await db.TimeIncident.findByPk(created.incident.id);
      assert.strictEqual(fresh.status, 'open', 'nothing changed');
      assert.strictEqual(fresh.selfResolved, false);

      const page = await s.supAg.get('/time/incidents/' + created.incident.id + '/');
      assert.ok(
        !new RegExp('/time/incidents/' + created.incident.id + '/resolve/').test(page.text),
        'the screen does not offer the decision on their own incident'
      );
    });

    it('18. the owner/admin resolves their own incident with an explicit audit row', async () => {
      const s = await setupCompany();
      const ownerUser = await userRow(s.owner.user);
      const created = await incidents.createIncident({
        models: db, actor: ownerUser, timezone: TZ,
        input: {
          type: 'exceptional_circumstance', title: 'Mine as owner',
          description: 'Administrative self-resolution.', local_date: localDate(1),
        },
      });

      const res = await postForm(s.ownerAg, '/time/incidents/' + created.incident.id + '/resolve/', {
        resolution: 'Acknowledged and closed by the owner.',
      });
      assert.ok([302, 303].includes(res.status));

      const fresh = await db.TimeIncident.findByPk(created.incident.id);
      assert.strictEqual(fresh.status, 'resolved');
      assert.strictEqual(fresh.selfResolved, true, 'the exception is flagged');
      assert.strictEqual(String(fresh.resolvedById), String(s.owner.user.id));
      assert.strictEqual(fresh.resolution, 'Acknowledged and closed by the owner.');

      const audits = await db.Audit.findAll({
        where: { entityType: 'TIME_INCIDENT', entityId: created.incident.id },
      });
      const flag = audits.find((a) => a.attribute === 'administrative_self_resolution');
      assert.ok(flag, 'the exception has its own audit row');
      const payload = JSON.parse(flag.newValue);
      assert.strictEqual(payload.selfResolved, true);
      assert.strictEqual(payload.role, 'owner');
      assert.strictEqual(String(payload.resolvedById), String(s.owner.user.id));
    });

    it('19. a revoked supervision link takes effect immediately', async () => {
      const s = await setupCompany();
      const helper = await addEmployee(s.adminAg, s.companyId, {
        name: 'Help', lastname: 'Ervisor',
      });
      await db.DepartmentSupervisor.create({ department_id: s.dept.id, user_id: helper.user.id });
      const helperAg = agent();
      await login(helperAg, helper.email, helper.password);

      const created = await incidents.createIncident({
        models: db, actor: await userRow(s.emp.user), timezone: TZ,
        input: {
          type: 'other', title: 'Before revocation', description: 'Visible now.',
          local_date: localDate(1),
        },
      });

      const helperUser = await userRow(helper.user);
      assert.strictEqual(
        await incidents.canManage({
          models: db, actor: helperUser, incident: created.incident,
        }),
        true,
        'the link allows deciding'
      );

      await db.DepartmentSupervisor.destroy({
        where: { department_id: s.dept.id, user_id: helper.user.id },
      });

      assert.strictEqual(
        await incidents.canManage({
          models: db, actor: helperUser, incident: created.incident,
        }),
        false,
        'without the link the right is gone'
      );

      const res = await postForm(helperAg, '/time/incidents/' + created.incident.id + '/resolve/', {
        resolution: 'Too late.',
      });
      assert.ok([302, 303].includes(res.status));

      const fresh = await db.TimeIncident.findByPk(created.incident.id);
      assert.strictEqual(fresh.status, 'open');
    });

    it('20. a department move takes the incident away from the old supervisor', async () => {
      const s = await setupCompany();
      const created = await incidents.createIncident({
        models: db, actor: await userRow(s.emp.user), timezone: TZ,
        input: {
          type: 'other', title: 'Before the move', description: 'Supervised today.',
          local_date: localDate(1),
        },
      });

      const supUser = await userRow(s.sup.user);
      assert.strictEqual(
        await incidents.canView({
          models: db, actor: supUser, incident: created.incident,
        }),
        true
      );

      const newDept = await db.Department.create({ name: 'New home', companyId: s.companyId });
      const empRow = await db.User.findByPk(s.emp.user.id);
      empRow.DepartmentId = newDept.id;
      await empRow.save();

      assert.strictEqual(
        await incidents.canView({
          models: db, actor: supUser, incident: created.incident,
        }),
        false,
        'the scope is evaluated against the current department'
      );
      assert.strictEqual(
        await incidents.canManage({
          models: db, actor: supUser, incident: created.incident,
        }),
        false
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('workflow', () => {
    async function openIncident(s) {
      return incidents.createIncident({
        models: db, actor: await userRow(s.emp.user), timezone: TZ,
        input: {
          type: 'clocking_problem', title: 'Pending case',
          description: 'A situation that needs a decision.', local_date: localDate(1),
        },
      });
    }

    it('21. open -> in_review', async () => {
      const s = await setupCompany();
      const created = await openIncident(s);

      const res = await postForm(s.supAg, '/time/incidents/' + created.incident.id + '/review/', {});
      assert.ok([302, 303].includes(res.status));

      const fresh = await db.TimeIncident.findByPk(created.incident.id);
      assert.strictEqual(fresh.status, 'in_review');
      assert.ok(fresh.reviewStartedAt);

      const entry = await db.TimeIncidentEntry.findOne({
        where: { incidentId: created.incident.id, kind: 'in_review' },
      });
      assert.ok(entry, 'the change is on the thread');
      assert.strictEqual(entry.fromStatus, 'open');
      assert.strictEqual(entry.toStatus, 'in_review');
    });

    it('22. open -> resolved with an answer the employee reads', async () => {
      const s = await setupCompany();
      const created = await openIncident(s);

      await postForm(s.supAg, '/time/incidents/' + created.incident.id + '/resolve/', {
        resolution: 'The platform log confirms the outage.',
      });

      const fresh = await db.TimeIncident.findByPk(created.incident.id);
      assert.strictEqual(fresh.status, 'resolved');
      assert.strictEqual(fresh.resolution, 'The platform log confirms the outage.');

      const page = await s.empAg.get('/time/incidents/' + created.incident.id + '/');
      assert.strictEqual(page.status, 200);
      assert.ok(/The platform log confirms the outage/.test(page.text));
    });

    it('23. in_review -> resolved', async () => {
      const s = await setupCompany();
      const created = await openIncident(s);

      await postForm(s.supAg, '/time/incidents/' + created.incident.id + '/review/', {});
      await postForm(s.supAg, '/time/incidents/' + created.incident.id + '/resolve/', {
        resolution: 'Reviewed and resolved.',
      });

      const fresh = await db.TimeIncident.findByPk(created.incident.id);
      assert.strictEqual(fresh.status, 'resolved');

      const entries = await db.TimeIncidentEntry.findAll({
        where: { incidentId: created.incident.id }, order: [['at', 'ASC'], ['id', 'ASC']],
      });
      assert.deepStrictEqual(entries.map((e) => e.kind), ['in_review', 'resolved']);
    });

    it('24. a dismissal always carries a reason', async () => {
      const s = await setupCompany();
      const created = await openIncident(s);

      const res = await postForm(s.supAg, '/time/incidents/' + created.incident.id + '/dismiss/', {
        resolution: 'Not a work-time incident: it was a personal errand.',
      });
      assert.ok([302, 303].includes(res.status));

      const fresh = await db.TimeIncident.findByPk(created.incident.id);
      assert.strictEqual(fresh.status, 'dismissed');
      assert.strictEqual(fresh.resolution, 'Not a work-time incident: it was a personal errand.');
      assert.ok(fresh.resolvedAt);
      assert.strictEqual(String(fresh.resolvedById), String(s.sup.user.id));
    });

    it('25. a resolution without an answer is refused', async () => {
      const s = await setupCompany();
      const created = await openIncident(s);

      const res = await postForm(s.supAg, '/time/incidents/' + created.incident.id + '/resolve/', {
        resolution: '   ',
      });
      assert.ok([302, 303].includes(res.status));

      const fresh = await db.TimeIncident.findByPk(created.incident.id);
      assert.strictEqual(fresh.status, 'open', 'nothing changed');

      const supUser = await userRow(s.sup.user);
      await assert.rejects(
        async () => incidents.resolveIncident({
          models: db, actor: supUser, incidentId: created.incident.id, response: '',
        }),
        /answer is required/i
      );
      await assert.rejects(
        async () => incidents.dismissIncident({
          models: db, actor: supUser, incidentId: created.incident.id, reason: '',
        }),
        /reason for the dismissal is required/i
      );
    });

    it('26. a double resolution cannot win twice', async () => {
      const s = await setupCompany();
      const created = await openIncident(s);
      const supUser = await userRow(s.sup.user);

      const first = await incidents.resolveIncident({
        models: db, actor: supUser, incidentId: created.incident.id, response: 'Resolved once.',
      });
      assert.strictEqual(first.status, 'resolved');

      await assert.rejects(
        async () => incidents.resolveIncident({
          models: db, actor: supUser, incidentId: created.incident.id, response: 'Resolved twice.',
        }),
        /already been processed|already closed/i
      );

      const fresh = await db.TimeIncident.findByPk(created.incident.id);
      assert.strictEqual(fresh.resolution, 'Resolved once.');
      assert.strictEqual(
        await db.TimeIncidentEntry.count({
          where: { incidentId: created.incident.id, kind: 'resolved' },
        }),
        1, 'exactly one resolution is recorded'
      );
    });

    it('27. a concurrent resolution and dismissal cannot both win', async () => {
      const s = await setupCompany();
      const created = await openIncident(s);
      const supUser = await userRow(s.sup.user);

      const results = await Promise.allSettled([
        incidents.resolveIncident({
          models: db, actor: supUser, incidentId: created.incident.id,
          response: 'Resolved by the first request.',
        }),
        incidents.dismissIncident({
          models: db, actor: supUser, incidentId: created.incident.id,
          reason: 'Dismissed by the second request.',
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      assert.strictEqual(fulfilled.length, 1, 'exactly one decision succeeded');

      const fresh = await db.TimeIncident.findByPk(created.incident.id);
      assert.ok(['resolved', 'dismissed'].includes(fresh.status));

      const closing = await db.TimeIncidentEntry.findAll({
        where: { incidentId: created.incident.id },
        order: [['id', 'ASC']],
      });
      const finals = closing.filter((e) => e.kind === 'resolved' || e.kind === 'dismissed');
      assert.strictEqual(finals.length, 1, 'exactly one closing entry');
      assert.strictEqual(finals[0].kind, fresh.status);
    });

    it('28. a transition from a final state is refused', async () => {
      const s = await setupCompany();
      const created = await openIncident(s);
      const supUser = await userRow(s.sup.user);

      await incidents.dismissIncident({
        models: db, actor: supUser, incidentId: created.incident.id, reason: 'Not applicable.',
      });

      await assert.rejects(
        async () => incidents.startReview({
          models: db, actor: supUser, incidentId: created.incident.id,
        }),
        /already closed|already been processed/i
      );
      await assert.rejects(
        async () => incidents.resolveIncident({
          models: db, actor: supUser, incidentId: created.incident.id, response: 'Reopen.',
        }),
        /already been processed|already closed/i
      );
      await assert.rejects(
        async () => incidents.dismissIncident({
          models: db, actor: supUser, incidentId: created.incident.id, reason: 'Again.',
        }),
        /already been processed|already closed/i
      );

      const fresh = await db.TimeIncident.findByPk(created.incident.id);
      assert.strictEqual(fresh.status, 'dismissed', 'the terminal state is respected');
    });

    it('29. the status change and its audit rows are atomic', async () => {
      const s = await setupCompany();
      const created = await openIncident(s);
      const supUser = await userRow(s.sup.user);

      await incidents.resolveIncident({
        models: db, actor: supUser, incidentId: created.incident.id,
        response: 'Everything is in order.',
      });

      const audits = await db.Audit.findAll({
        where: { entityType: 'TIME_INCIDENT', entityId: created.incident.id },
      });
      const status = audits.find((a) => a.attribute === 'status' && a.newValue === 'resolved');
      assert.ok(status, 'the transition is audited');
      assert.strictEqual(status.oldValue, 'open');
      assert.ok(audits.find((a) => a.attribute === 'resolution'));
      assert.ok(audits.find((a) => a.attribute === 'resolved_by'));

      const entry = await db.TimeIncidentEntry.findOne({
        where: { incidentId: created.incident.id, kind: 'resolved' },
      });
      assert.ok(entry, 'the thread has the closing entry');
      assert.strictEqual(entry.authorId, s.sup.user.id);
    });

    it('30. an injected failure rolls the whole decision back', async () => {
      const s = await setupCompany();
      const created = await openIncident(s);
      const supUser = await userRow(s.sup.user);

      const original = db.TimeIncidentEntry.create;
      db.TimeIncidentEntry.create = async () => { throw new Error('simulated database failure'); };
      let failed = false;
      try {
        await incidents.resolveIncident({
          models: db, actor: supUser, incidentId: created.incident.id,
          response: 'This must never be stored.',
        });
      } catch (e) {
        failed = true;
      } finally {
        db.TimeIncidentEntry.create = original;
      }

      assert.ok(failed, 'the failure was propagated');

      const fresh = await db.TimeIncident.findByPk(created.incident.id);
      assert.strictEqual(fresh.status, 'open', 'the status was rolled back');
      assert.strictEqual(fresh.resolvedAt, null);
      assert.strictEqual(fresh.resolution, null);
      assert.strictEqual(
        await db.TimeIncidentEntry.count({ where: { incidentId: created.incident.id } }), 0,
        'no orphan entry survived'
      );
      assert.strictEqual(
        await db.Audit.count({
          where: { entityType: 'TIME_INCIDENT', entityId: created.incident.id, attribute: 'resolution' },
        }),
        0, 'no orphan audit row survived'
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('activity', () => {
    it('31. the employee adds a clarification', async () => {
      const s = await setupCompany();
      const created = await incidents.createIncident({
        models: db, actor: await userRow(s.emp.user), timezone: TZ,
        input: {
          type: 'other', title: 'Needs a detail', description: 'First version.',
          local_date: localDate(1),
        },
      });

      const res = await postForm(s.empAg, '/time/incidents/' + created.incident.id + '/comments/', {
        body: 'Additional detail: it also affected the second floor.',
      });
      assert.ok([302, 303].includes(res.status));

      const entry = await db.TimeIncidentEntry.findOne({
        where: { incidentId: created.incident.id, kind: 'comment' },
      });
      assert.ok(entry);
      assert.strictEqual(entry.body, 'Additional detail: it also affected the second floor.');
      assert.strictEqual(entry.authorId, s.emp.user.id);

      const fresh = await db.TimeIncident.findByPk(created.incident.id);
      assert.strictEqual(fresh.status, 'open', 'a message does not change the status');
    });

    it('32. the responsible person answers in the thread', async () => {
      const s = await setupCompany();
      const created = await incidents.createIncident({
        models: db, actor: await userRow(s.emp.user), timezone: TZ,
        input: {
          type: 'clocking_problem', title: 'Question', description: 'Why is my hour missing?',
          local_date: localDate(1),
        },
      });

      await postForm(s.supAg, '/time/incidents/' + created.incident.id + '/comments/', {
        body: 'I am checking the platform log and will answer today.',
      });

      const entry = await db.TimeIncidentEntry.findOne({
        where: { incidentId: created.incident.id, kind: 'comment' },
      });
      assert.strictEqual(entry.authorId, s.sup.user.id);

      const page = await s.empAg.get('/time/incidents/' + created.incident.id + '/');
      assert.ok(/will answer today/.test(page.text), 'the employee reads the answer');
    });

    it('33. a message on a closed incident is refused', async () => {
      const s = await setupCompany();
      const created = await incidents.createIncident({
        models: db, actor: await userRow(s.emp.user), timezone: TZ,
        input: {
          type: 'other', title: 'Closed soon', description: 'To be closed.',
          local_date: localDate(1),
        },
      });

      await incidents.resolveIncident({
        models: db, actor: await userRow(s.sup.user),
        incidentId: created.incident.id, response: 'Closed.',
      });

      const res = await postForm(s.empAg, '/time/incidents/' + created.incident.id + '/comments/', {
        body: 'One more thing after the closing.',
      });
      assert.ok([302, 303].includes(res.status));

      assert.strictEqual(
        await db.TimeIncidentEntry.count({
          where: { incidentId: created.incident.id, kind: 'comment' },
        }),
        0, 'nothing is appended after the closing'
      );

      const page = await s.empAg.get('/time/incidents/' + created.incident.id + '/');
      assert.ok(/no more messages can be added/i.test(page.text));
      assert.ok(
        !new RegExp('/time/incidents/' + created.incident.id + '/comments/').test(page.text),
        'the form is not offered'
      );
    });

    it('34. an unrelated user cannot comment', async () => {
      const s = await setupCompany();
      const created = await incidents.createIncident({
        models: db, actor: await userRow(s.emp.user), timezone: TZ,
        input: {
          type: 'other', title: 'Private', description: 'Only the employee and the supervisor.',
          local_date: localDate(1),
        },
      });

      const foreign = await addColleague(s.adminAg, s.companyId);
      const foreignUser = await userRow(foreign.user);

      await assert.rejects(
        async () => incidents.addComment({
          models: db, actor: foreignUser, incidentId: created.incident.id, body: 'Intrusion.',
        }),
        /Unknown incident/i
      );

      assert.strictEqual(
        await db.TimeIncidentEntry.count({ where: { incidentId: created.incident.id } }), 0
      );
    });

    it('35. the thread keeps the chronological order', async () => {
      const s = await setupCompany();
      const created = await incidents.createIncident({
        models: db, actor: await userRow(s.emp.user), timezone: TZ,
        input: {
          type: 'other', title: 'Order', description: 'Chronology.',
          local_date: localDate(1),
        },
      });

      const base = Date.now();
      const empUser = await userRow(s.emp.user);
      const supUser = await userRow(s.sup.user);

      await incidents.addComment({
        models: db, actor: empUser, incidentId: created.incident.id, body: 'first',
        now: new Date(base),
      });
      await incidents.addComment({
        models: db, actor: supUser, incidentId: created.incident.id, body: 'second',
        now: new Date(base + 60000),
      });
      await incidents.addComment({
        models: db, actor: empUser, incidentId: created.incident.id, body: 'third',
        now: new Date(base + 120000),
      });

      const entries = await incidents.listEntries({
        models: db, companyId: s.companyId, incidentId: created.incident.id,
      });
      assert.deepStrictEqual(entries.map((e) => e.body), ['first', 'second', 'third']);

      const page = await s.empAg.get('/time/incidents/' + created.incident.id + '/');
      const text = page.text;
      assert.ok(text.indexOf('first') < text.indexOf('second'));
      assert.ok(text.indexOf('second') < text.indexOf('third'));
    });

    it('36. a comment racing the closing either comes first or is refused', async () => {
      const s = await setupCompany();
      const created = await incidents.createIncident({
        models: db, actor: await userRow(s.emp.user), timezone: TZ,
        input: {
          type: 'other', title: 'Race', description: 'Comment against closing.',
          local_date: localDate(1),
        },
      });

      const empUser = await userRow(s.emp.user);
      const supUser = await userRow(s.sup.user);

      const results = await Promise.allSettled([
        incidents.addComment({
          models: db, actor: empUser, incidentId: created.incident.id,
          body: 'A last clarification.',
        }),
        incidents.resolveIncident({
          models: db, actor: supUser, incidentId: created.incident.id,
          response: 'Closing now.',
        }),
      ]);

      const comment = results[0];
      const closing = results[1];
      assert.strictEqual(closing.status, 'fulfilled', 'the decision always completes');

      const entries = await db.TimeIncidentEntry.findAll({
        where: { incidentId: created.incident.id }, order: [['id', 'ASC']],
      });
      const resolvedEntry = entries.find((e) => e.kind === 'resolved');
      assert.ok(resolvedEntry, 'the closing entry exists');

      if (comment.status === 'fulfilled') {
        const commentEntry = entries.find((e) => e.kind === 'comment');
        assert.ok(commentEntry, 'the comment was stored');
        assert.ok(
          commentEntry.id < resolvedEntry.id,
          'the comment is before the closing, never after it'
        );
      } else {
        assert.ok(
          /closed|no more messages/i.test(comment.reason.message),
          'the refusal explains that the incident is closed: ' + comment.reason.message
        );
        assert.strictEqual(
          entries.filter((e) => e.kind === 'comment').length, 0
        );
      }
    });

    it('37. the thread is append-only: no entry is ever updated or deleted', async () => {
      const s = await setupCompany();
      const created = await incidents.createIncident({
        models: db, actor: await userRow(s.emp.user), timezone: TZ,
        input: {
          type: 'other', title: 'Immutable', description: 'The original text.',
          local_date: localDate(1),
        },
      });

      const empUser = await userRow(s.emp.user);
      const supUser = await userRow(s.sup.user);
      await incidents.addComment({
        models: db, actor: empUser, incidentId: created.incident.id, body: 'original message',
      });

      const before = await db.TimeIncidentEntry.findAll({
        where: { incidentId: created.incident.id }, order: [['id', 'ASC']],
      });

      await incidents.resolveIncident({
        models: db, actor: supUser, incidentId: created.incident.id, response: 'Closed.',
      });

      const after = await db.TimeIncidentEntry.findAll({
        where: { incidentId: created.incident.id }, order: [['id', 'ASC']],
      });

      assert.ok(after.length > before.length, 'only appends happened');
      before.forEach((old, index) => {
        assert.strictEqual(after[index].id, old.id, 'the previous entries keep their identity');
        assert.strictEqual(after[index].body, old.body, 'the previous entries keep their text');
        assert.strictEqual(after[index].kind, old.kind);
      });

      // The original description of the incident is never rewritten either.
      const fresh = await db.TimeIncident.findByPk(created.incident.id);
      assert.strictEqual(fresh.description, 'The original text.');
      assert.strictEqual(fresh.title, 'Immutable');
    });
  });

  // -------------------------------------------------------------------------
  describe('integration', () => {
    it('38. the employee links their own correction request', async () => {
      const s = await setupCompany();
      const entry = await seedSession({ companyId: s.companyId, userId: s.emp.user.id });

      const correction = await corrections.createRequest({
        models: db, actor: await userRow(s.emp.user), type: 'entry_start',
        entryId: entry.id,
        input: { date: localDate(3), time: '08:30', reason: 'forgot to clock in' },
        timezone: TZ,
      });

      const created = await incidents.createIncident({
        models: db, actor: await userRow(s.emp.user), timezone: TZ,
        input: {
          type: 'clocking_problem', title: 'Outage and correction',
          description: 'The app was down, so I also requested a correction.',
          local_date: localDate(3),
        },
      });

      const res = await postForm(s.empAg, '/time/incidents/' + created.incident.id + '/link/', {
        correction_id: String(correction.correction.id),
      });
      assert.ok([302, 303].includes(res.status));

      const fresh = await db.TimeIncident.findByPk(created.incident.id);
      assert.strictEqual(String(fresh.timeCorrectionId), String(correction.correction.id));

      const linkEntry = await db.TimeIncidentEntry.findOne({
        where: { incidentId: created.incident.id, kind: 'link' },
      });
      assert.ok(linkEntry, 'the link is on the thread');

      const audits = await db.Audit.findAll({
        where: { entityType: 'TIME_INCIDENT', entityId: created.incident.id },
      });
      assert.ok(audits.find((a) => a.attribute === 'time_correction_id'));

      const page = await s.empAg.get('/time/incidents/' + created.incident.id + '/');
      assert.ok(new RegExp('Correction request #' + correction.correction.id).test(page.text));
    });

    it('39. a correction of another company cannot be linked', async () => {
      const s = await setupCompany();
      const otherAdminAg = agent();
      const other = await registerAdmin(otherAdminAg, { company: 'LinkForeign' });
      const foreignEntry = await seedSession({
        companyId: other.user.companyId, userId: other.user.id,
      });
      const foreignCorrection = await corrections.createRequest({
        models: db, actor: await userRow(other.user), type: 'entry_start',
        entryId: foreignEntry.id,
        input: { date: localDate(3), time: '08:30', reason: 'foreign' },
        timezone: TZ,
      });

      const created = await incidents.createIncident({
        models: db, actor: await userRow(s.emp.user), timezone: TZ,
        input: {
          type: 'other', title: 'Link attempt', description: 'Cross company.',
          local_date: localDate(1),
        },
      });

      await assert.rejects(
        async () => incidents.linkCorrection({
          models: db, actor: await userRow(s.emp.user),
          incidentId: created.incident.id,
          correctionId: foreignCorrection.correction.id,
        }),
        /Unknown correction request/i
      );

      const res = await postForm(s.empAg, '/time/incidents/' + created.incident.id + '/link/', {
        correction_id: String(foreignCorrection.correction.id),
      });
      assert.ok([302, 303].includes(res.status));

      const fresh = await db.TimeIncident.findByPk(created.incident.id);
      assert.strictEqual(fresh.timeCorrectionId, null);
    });

    it('40. linking a correction neither approves nor applies it', async () => {
      const s = await setupCompany();
      const entry = await seedSession({ companyId: s.companyId, userId: s.emp.user.id });

      const correction = await corrections.createRequest({
        models: db, actor: await userRow(s.emp.user), type: 'entry_end',
        entryId: entry.id,
        input: { date: localDate(3), time: '18:00', reason: 'stayed late' },
        timezone: TZ,
      });
      assert.strictEqual(correction.correction.status, 'pending');

      const created = await incidents.createIncident({
        models: db, actor: await userRow(s.emp.user), timezone: TZ,
        input: {
          type: 'clocking_problem', title: 'Reference only',
          description: 'Please look at my correction.', local_date: localDate(3),
        },
      });

      await incidents.linkCorrection({
        models: db, actor: await userRow(s.emp.user),
        incidentId: created.incident.id, correctionId: correction.correction.id,
      });

      const freshCorrection = await db.TimeCorrection.findByPk(correction.correction.id);
      assert.strictEqual(freshCorrection.status, 'pending', 'the correction is still pending');

      const entryAfter = await db.TimeEntry.findByPk(entry.id);
      assert.strictEqual(
        moment.utc(entryAfter.endedAt).tz(TZ).format('HH:mm'), '17:00',
        'the effective clock-out was not touched'
      );
    });

    it('41. a correction in conflict does not resolve the incident', async () => {
      const s = await setupCompany();
      const entry = await seedSession({ companyId: s.companyId, userId: s.emp.user.id });

      const correction = await corrections.createRequest({
        models: db, actor: await userRow(s.emp.user), type: 'entry_start',
        entryId: entry.id,
        input: { date: localDate(3), time: '08:30', reason: 'forgot to clock in' },
        timezone: TZ,
      });

      const created = await incidents.createIncident({
        models: db, actor: await userRow(s.emp.user), timezone: TZ,
        input: {
          type: 'clocking_problem', title: 'Conflict case',
          description: 'The correction may end in conflict.', local_date: localDate(3),
        },
      });

      await incidents.linkCorrection({
        models: db, actor: await userRow(s.emp.user),
        incidentId: created.incident.id, correctionId: correction.correction.id,
      });

      // The session changes: the correction becomes a conflict when resolved.
      await db.TimeEntry.update(
        { startedAt: moment.tz(`${localDate(3)} 09:30`, 'YYYY-MM-DD HH:mm', TZ).toDate() },
        { where: { id: entry.id } }
      );

      const outcome = await corrections.resolveRequest({
        models: db, actor: await userRow(s.sup.user),
        correctionId: correction.correction.id, decision: 'approve',
      });
      assert.strictEqual(outcome.status, 'conflict');

      const freshIncident = await db.TimeIncident.findByPk(created.incident.id);
      assert.strictEqual(freshIncident.status, 'open', 'the incident is not resolved automatically');
    });

    it('42. an incident never changes the clock record nor the computation', async () => {
      const s = await setupCompany();
      const entry = await seedSession({ companyId: s.companyId, userId: s.emp.user.id });
      await db.TimeBreak.create({
        companyId: s.companyId, userId: s.emp.user.id, timeEntryId: entry.id,
        type: 'regular', countsAsWork: false,
        startedAt: moment.tz(`${localDate(3)} 12:00`, 'YYYY-MM-DD HH:mm', TZ).toDate(),
        endedAt: moment.tz(`${localDate(3)} 12:30`, 'YYYY-MM-DD HH:mm', TZ).toDate(),
      });

      const snapshot = async () => {
        const rows = await db.TimeEntry.findAll({
          where: { userId: s.emp.user.id }, order: [['id', 'ASC']], raw: true,
        });
        const breaks = await db.TimeBreak.findAll({
          where: { userId: s.emp.user.id }, order: [['id', 'ASC']], raw: true,
        });
        const events = await db.TimeEntryEvent.count({ where: { userId: s.emp.user.id } });
        return JSON.stringify({ rows, breaks, events });
      };

      const before = await snapshot();

      const created = await incidents.createIncident({
        models: db, actor: await userRow(s.emp.user), timezone: TZ,
        input: {
          type: 'work_interruption', title: 'No effect on the record',
          description: 'This must not touch the session.', local_date: localDate(3),
          time_entry_id: String(entry.id),
        },
      });
      await incidents.addComment({
        models: db, actor: await userRow(s.sup.user),
        incidentId: created.incident.id, body: 'Noted.',
      });
      await incidents.resolveIncident({
        models: db, actor: await userRow(s.sup.user),
        incidentId: created.incident.id, response: 'Acknowledged.',
      });

      const after = await snapshot();
      assert.strictEqual(after, before, 'the session, the breaks and the events are untouched');
    });

    it('43. an incident never creates or changes an absence', async () => {
      const s = await setupCompany();
      const empRow = await db.User.findByPk(s.emp.user.id);
      const before = await db.Leave.count({ where: { userId: empRow.id } });

      const created = await incidents.createIncident({
        models: db, actor: await userRow(s.emp.user), timezone: TZ,
        input: {
          type: 'exceptional_circumstance', title: 'I was not feeling well',
          description: 'I need to know whether this is an absence.',
          local_date: localDate(1),
        },
      });
      await incidents.resolveIncident({
        models: db, actor: await userRow(s.sup.user),
        incidentId: created.incident.id,
        response: 'Please request a sick leave through the absence process.',
      });

      assert.strictEqual(
        await db.Leave.count({ where: { userId: empRow.id } }), before,
        'no absence is created'
      );
    });

    it('44. blocks 1-3 keep working next to the incidents', async () => {
      const s = await setupCompany();

      // The clock still starts and stops.
      const start = await postForm(s.empAg, '/time/start', { modality: 'office' });
      assert.ok([302, 303].includes(start.status));
      const open = await db.TimeEntry.findOne({
        where: { userId: s.emp.user.id, status: 'open' },
      });
      assert.ok(open, 'the session was opened');

      // A pending incident does not interfere.
      await fileIncident(s.empAg, {
        title: 'While clocked in', description: 'Filing an incident during the session.',
        time_entry_id: String(open.id),
      });

      const stop = await postForm(s.empAg, '/time/stop', {});
      assert.ok([302, 303].includes(stop.status));
      const closed = await db.TimeEntry.findByPk(open.id);
      assert.strictEqual(closed.status, 'closed');

      // The corrections of block 3 still work.
      const correction = await corrections.createRequest({
        models: db, actor: await userRow(s.emp.user), type: 'entry_start',
        entryId: closed.id,
        input: {
          date: moment.utc(closed.startedAt).tz(TZ).format('YYYY-MM-DD'),
          time: '08:45', reason: 'earlier start',
        },
        timezone: TZ,
      });
      assert.strictEqual(correction.correction.status, 'pending');
    });

    it('45. historical references survive the deletion rules', async () => {
      const s = await setupCompany();
      const entry = await seedSession({ companyId: s.companyId, userId: s.emp.user.id });

      const created = await incidents.createIncident({
        models: db, actor: await userRow(s.emp.user), timezone: TZ,
        input: {
          type: 'clocking_problem', title: 'Historical', description: 'Kept forever.',
          local_date: localDate(3), time_entry_id: String(entry.id),
        },
      });

      // An employee with incidents cannot be removed: the history is kept.
      const empRow = await db.User.findByPk(s.emp.user.id);
      await assert.rejects(
        () => empRow.remove(),
        /recorded time sessions|work-time incidents/i
      );
      assert.ok(await db.User.findByPk(s.emp.user.id), 'the employee still exists');

      // The incident survives a retry and keeps its reference.
      const fresh = await db.TimeIncident.findByPk(created.incident.id);
      assert.ok(fresh, 'the incident is still there');
      assert.strictEqual(String(fresh.timeEntryId), String(entry.id));

      // Even with NO work session at all, an incident blocks the deletion: the
      // incident history is part of the labour record and is never destroyed.
      const withoutSessions = await addEmployee(s.adminAg, s.companyId, {
        name: 'No', lastname: 'Sessions',
      });
      await incidents.createIncident({
        models: db, actor: await userRow(withoutSessions.user), timezone: TZ,
        input: {
          type: 'clocking_problem', title: 'No session incident',
          description: 'The system was down before any session existed.',
          local_date: localDate(2),
        },
      });
      const noSessionsRow = await db.User.findByPk(withoutSessions.user.id);
      await assert.rejects(
        () => noSessionsRow.remove(),
        /work-time incidents/i,
        'the incident guard refuses on its own'
      );
      assert.ok(await db.User.findByPk(withoutSessions.user.id));
    });
  });

  // -------------------------------------------------------------------------
  describe('security', () => {
    it('46. a POST without a CSRF token is rejected', async () => {
      const s = await setupCompany();

      const res = await s.empAg.post('/time/incidents/').type('form').send({
        type: 'other', local_date: localDate(1), title: 'No token', description: 'No token.',
      });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(
        await db.TimeIncident.count({ where: { userId: s.emp.user.id } }), 0
      );
    });

    it('47. a multipart incident is rejected', async () => {
      const s = await setupCompany();
      const res = await s.empAg.post('/time/incidents/')
        .attach('file', Buffer.from('x'), 'x.txt');
      assert.strictEqual(res.status, 403);
      assert.strictEqual(
        await db.TimeIncident.count({ where: { userId: s.emp.user.id } }), 0
      );
    });

    it('48. a manipulated identifier is not honoured (IDOR)', async () => {
      const s = await setupCompany();
      const created = await incidents.createIncident({
        models: db, actor: await userRow(s.emp.user), timezone: TZ,
        input: {
          type: 'other', title: 'Protected', description: 'Only for its participants.',
          local_date: localDate(1),
        },
      });

      const foreign = await addColleague(s.adminAg, s.companyId);

      // The detail page is a GET: a foreign user is redirected, never served.
      const detail = await foreign.ag.get('/time/incidents/' + created.incident.id + '/');
      assert.ok([302, 303].includes(detail.status), 'the detail page is refused');
      assert.ok(!/Protected/.test(detail.text), 'the content does not leak');

      const paths = [
        '/time/incidents/' + created.incident.id + '/comments/',
        '/time/incidents/' + created.incident.id + '/resolve/',
        '/time/incidents/' + created.incident.id + '/dismiss/',
        '/time/incidents/' + created.incident.id + '/review/',
        '/time/incidents/' + created.incident.id + '/link/',
      ];

      for (const path of paths) {
        const res = await postForm(foreign.ag, path, {
          body: 'Intrusion.', resolution: 'Intrusion.', correction_id: '1',
        });
        assert.ok([302, 303].includes(res.status), path + ' answers with a redirect');
      }

      const fresh = await db.TimeIncident.findByPk(created.incident.id);
      assert.strictEqual(fresh.status, 'open');
      assert.strictEqual(fresh.resolution, null);
      assert.strictEqual(
        await db.TimeIncidentEntry.count({ where: { incidentId: created.incident.id } }), 0
      );
    });

    it('49. mass assignment cannot set the workflow fields', async () => {
      const s = await setupCompany();

      await fileIncident(s.empAg, {
        status: 'resolved',
        resolved_at: new Date().toISOString(),
        resolved_by_id: String(s.emp.user.id),
        self_resolved: 'true',
        user_id: String(s.sup.user.id),
        company_id: '999999',
        time_correction_id: '1',
      });

      const row = await db.TimeIncident.findOne({ where: { userId: s.emp.user.id } });
      assert.ok(row);
      assert.strictEqual(row.status, 'open', 'the status cannot be forced');
      assert.strictEqual(row.resolvedAt, null);
      assert.strictEqual(row.resolvedById, null);
      assert.strictEqual(row.selfResolved, false);
      assert.strictEqual(row.companyId, s.companyId, 'the company cannot be forced');
      assert.strictEqual(row.timeCorrectionId, null, 'the correction cannot be forced');
    });

    it('50. the user content is escaped', async () => {
      const s = await setupCompany();
      const created = await incidents.createIncident({
        models: db, actor: await userRow(s.emp.user), timezone: TZ,
        input: {
          type: 'other',
          title: '<script>alert("t")</script>',
          description: '<img src=x onerror="alert(1)"> text',
          local_date: localDate(1),
        },
      });
      await incidents.addComment({
        models: db, actor: await userRow(s.emp.user),
        incidentId: created.incident.id, body: '<b onmouseover="alert(2)">bold</b>',
      });

      const page = await s.empAg.get('/time/incidents/' + created.incident.id + '/');
      assert.strictEqual(page.status, 200);
      assert.ok(!/<script>alert\("t"\)<\/script>/.test(page.text), 'the script is not rendered');
      assert.ok(!/<img src=x onerror/.test(page.text), 'the image handler is not rendered');
      assert.ok(!/<b onmouseover/.test(page.text), 'the inline handler is not rendered');
      assert.ok(/&lt;script&gt;/.test(page.text), 'it is rendered escaped instead');

      const list = await s.empAg.get('/time/incidents/');
      assert.ok(!/<script>alert/.test(list.text), 'the list escapes the title too');
    });

    it('51. a failing query answers 500 and does not crash the process', async () => {
      const s = await setupCompany();
      const original = db.TimeIncident.findAll;
      db.TimeIncident.findAll = async () => { throw new Error('simulated database failure'); };
      let res;
      try {
        res = await s.empAg.get('/time/incidents/');
      } finally {
        db.TimeIncident.findAll = original;
      }
      assert.strictEqual(res.status, 500, 'the async error reaches the error handler');

      // The application is still alive and answers again.
      const after = await s.empAg.get('/time/incidents/');
      assert.strictEqual(after.status, 200);
    });

    it('52. the service validates what the routes cannot', async () => {
      const s = await setupCompany();
      const empUser = await userRow(s.emp.user);

      await assert.rejects(
        async () => incidents.createIncident({
          models: db, actor: empUser, timezone: TZ,
          input: { type: '', title: '', description: '', local_date: '' },
        }),
        /valid incident type/i
      );

      await assert.rejects(
        async () => incidents.createIncident({
          models: db, actor: empUser, timezone: TZ,
          input: {
            type: 'other', title: 'ok', description: 'ok', local_date: localDate(1),
            time_entry_id: '999999',
          },
        }),
        /does not exist/i
      );

      const created = await incidents.createIncident({
        models: db, actor: empUser, timezone: TZ,
        input: {
          type: 'other', title: 'ok', description: 'ok', local_date: localDate(1),
        },
      });
      await assert.rejects(
        async () => incidents.addComment({
          models: db, actor: empUser, incidentId: created.incident.id,
          body: 'x'.repeat(incidents.LIMITS.MESSAGE + 1),
        }),
        /too long/i
      );
    });

    it('53. the database restrictions are in place', async () => {
      const s = await setupCompany();

      // The model refuses an unknown status.
      await assert.rejects(
        () => db.TimeIncident.create({
          companyId: s.companyId, userId: s.emp.user.id,
          localDate: localDate(1), type: 'other', title: 'x', description: 'y',
          status: 'invented', openedAt: new Date(), lastActivityAt: new Date(),
        }),
        /Validation error|isIn/i
      );

      // The model refuses an unknown type.
      await assert.rejects(
        () => db.TimeIncident.create({
          companyId: s.companyId, userId: s.emp.user.id,
          localDate: localDate(1), type: 'invented', title: 'x', description: 'y',
          openedAt: new Date(), lastActivityAt: new Date(),
        }),
        /Validation error|isIn/i
      );

      // The model refuses an unknown entry kind.
      const created = await incidents.createIncident({
        models: db, actor: await userRow(s.emp.user), timezone: TZ,
        input: {
          type: 'other', title: 'Restrictions', description: 'For the kind check.',
          local_date: localDate(1),
        },
      });
      await assert.rejects(
        () => db.TimeIncidentEntry.create({
          companyId: s.companyId, incidentId: created.incident.id,
          authorId: s.emp.user.id, kind: 'invented', body: 'x', at: new Date(),
        }),
        /Validation error|isIn/i
      );
    });

    it('54. every operation is scoped to the company', async () => {
      const s = await setupCompany();
      const otherAdminAg = agent();
      const other = await registerAdmin(otherAdminAg, { company: 'Isolation Co' });

      const created = await incidents.createIncident({
        models: db, actor: await userRow(s.emp.user), timezone: TZ,
        input: {
          type: 'other', title: 'Isolated', description: 'Company A only.',
          local_date: localDate(1),
        },
      });

      const otherUser = await userRow(other.user);

      // Read, decide and link: nothing crosses the company boundary.
      await assert.rejects(
        async () => incidents.getForActor({
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

      const queue = await otherAdminAg.get('/time/incidents/queue/');
      assert.ok(!/Isolated/.test(queue.text), 'the queue does not leak across companies');

      const list = await otherAdminAg.get('/time/incidents/');
      assert.ok(!/Isolated/.test(list.text));
    });
  });

  // -------------------------------------------------------------------------
  describe('schema compatibility (SQLite)', () => {
    it('55. the two tables exist with their indexes', async () => {
      const [tables] = await db.sequelize.query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('time_incidents', 'time_incident_entries')"
      );
      assert.strictEqual(tables.length, 2);

      const [indexes] = await db.sequelize.query(
        "SELECT name FROM sqlite_master WHERE type = 'index' " +
        "AND name = 'time_incidents_one_per_idempotency_key'"
      );
      assert.strictEqual(indexes.length, 1, 'the partial unique index exists');
    });

    it('56. the foreign keys are declared', async () => {
      const entryFks = await db.sequelize.query(
        'PRAGMA foreign_key_list(time_incident_entries)',
        { type: db.sequelize.QueryTypes.SELECT }
      );
      const entryTargets = entryFks.map((fk) => fk.table);
      assert.ok(entryTargets.includes('time_incidents'), 'the thread points at the incident');
      assert.ok(entryTargets.includes('Users'), 'the thread points at the author');
      assert.ok(entryTargets.includes('Companies'), 'the thread points at the company');

      const incidentFks = await db.sequelize.query(
        'PRAGMA foreign_key_list(time_incidents)',
        { type: db.sequelize.QueryTypes.SELECT }
      );
      const incidentTargets = incidentFks.map((fk) => fk.table);
      assert.ok(incidentTargets.includes('time_entries'), 'the optional session is a real FK');
      assert.ok(incidentTargets.includes('time_corrections'), 'the optional correction is a real FK');
      assert.ok(incidentTargets.includes('Users'), 'the creator and the resolver are real FKs');
      assert.ok(incidentTargets.includes('Companies'));
    });

    it('57. the partial unique index refuses two incidents with the same token', async () => {
      const s = await setupCompany();
      const base = {
        companyId: s.companyId, userId: s.emp.user.id,
        localDate: localDate(1), type: 'other', title: 'dup', description: 'dup',
        openedAt: new Date(), lastActivityAt: new Date(),
        idempotencyKey: 'same-token-' + Math.random().toString(36).slice(2, 8),
      };
      await db.TimeIncident.create(base);
      await assert.rejects(
        () => db.TimeIncident.create(base),
        /unique|constraint/i,
        'the database refuses the duplicate'
      );
    });

    it('58. the migration is reversible', async () => {
      const migration = require('../../migrations/20260108000000-time-incidents');
      assert.strictEqual(typeof migration.up, 'function');
      assert.strictEqual(typeof migration.down, 'function');
      assert.deepStrictEqual(migration.INCIDENT_TYPES, incidents.TYPE_VALUES);
      assert.deepStrictEqual(migration.INCIDENT_STATUSES, incidents.STATUS_VALUES);
      assert.deepStrictEqual(
        migration.ENTRY_KINDS, Object.values(incidents.ENTRY_KIND)
      );
    });
  });
});