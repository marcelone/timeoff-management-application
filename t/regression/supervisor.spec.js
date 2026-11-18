'use strict';

const assert = require('assert');
const H = require('./helper');
const { agent, registerAdmin, addEmployee, holidayType, bookLeave, postForm, login, db } = H;

const S = { NEW: 1, APPROVED: 2, REJECTED: 3 };

describe('non-admin supervisor approvals & department permission rules', () => {
  async function setupWithSupervisor() {
    const adminAg = agent();
    const { user: admin } = await registerAdmin(adminAg);
    const companyId = admin.companyId;
    const lt = await holidayType(companyId);
    const dept = await db.Department.findOne({ where: { companyId } });

    const sup = await addEmployee(adminAg, companyId, { name: 'Sup', lastname: 'Ervisor' });
    const emp = await addEmployee(adminAg, companyId, { name: 'Emp', lastname: 'Loyee' });

    // Make the (non-admin) supervisor the boss of the department.
    dept.bossId = sup.user.id;
    await dept.save();

    const supAg = agent();
    await login(supAg, sup.email, sup.password);
    const empAg = agent();
    await login(empAg, emp.email, emp.password);

    return { adminAg, admin, companyId, lt, dept, sup, emp, supAg, empAg };
  }

  it('non-admin supervisor approves a supervised employee leave (persisted)', async () => {
    const s = await setupWithSupervisor();
    assert.strictEqual(s.sup.user.admin, false, 'supervisor is not admin');
    const leave = await bookLeave(s.empAg, { leaveTypeId: s.lt.id, userId: s.emp.user.id, from: '2026-12-01', to: '2026-12-01' });
    assert.strictEqual(leave.status, S.NEW);
    assert.strictEqual(leave.approverId, s.sup.user.id, 'boss is the supervisor');

    const res = await postForm(s.supAg, '/requests/approve/', { request: String(leave.id) });
    assert.ok([302, 303].includes(res.status));
    const r = await db.Leave.findByPk(leave.id);
    assert.strictEqual(r.status, S.APPROVED, 'supervisor approval persisted');
    assert.strictEqual(r.approverId, s.sup.user.id);
  });

  it('supervisor cannot approve leave from a different department', async () => {
    const s = await setupWithSupervisor();
    // Another department with its own employee (boss = admin, not our supervisor).
    const otherDept = await db.Department.create({ name: 'Other', companyId: s.companyId });
    const other = await db.User.create({
      email: `other-${Date.now()}@example.com`, password: 'x', name: 'Other', lastname: 'Dept',
      companyId: s.companyId, DepartmentId: otherDept.id, admin: false, activated: true,
      start_date: '2026-01-01',
    });
    const otherAg = agent();
    // login other via password reset is complex; book directly through model API instead
    const leave = await db.Leave.create({
      userId: other.id, leaveTypeId: s.lt.id, status: S.NEW, approverId: s.admin.id,
      date_start: '2026-12-02', date_end: '2026-12-02', day_part_start: 1, day_part_end: 1,
    });

    const res = await postForm(s.supAg, '/requests/approve/', { request: String(leave.id) });
    assert.ok([302, 303].includes(res.status));
    const r = await db.Leave.findByPk(leave.id);
    assert.strictEqual(r.status, S.NEW, 'other-department leave NOT approved by supervisor');
  });

  it('non-admin supervisor cannot access company settings (303)', async () => {
    const s = await setupWithSupervisor();
    const res = await s.supAg.get('/settings/');
    assert.strictEqual(res.status, 303);
  });

  it('supervisor can reject a supervised leave (persisted)', async () => {
    const s = await setupWithSupervisor();
    const leave = await bookLeave(s.empAg, { leaveTypeId: s.lt.id, userId: s.emp.user.id, from: '2026-12-05', to: '2026-12-05' });
    const res = await postForm(s.supAg, '/requests/reject/', { request: String(leave.id) });
    assert.ok([302, 303].includes(res.status));
    const r = await db.Leave.findByPk(leave.id);
    assert.strictEqual(r.status, S.REJECTED);
  });
});
