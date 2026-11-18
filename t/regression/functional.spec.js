'use strict';

const assert = require('assert');
const H = require('./helper');
const { agent, registerAdmin, login, addEmployee, holidayType, bookLeave, postForm, db } = H;

const S = { NEW: 1, APPROVED: 2, REJECTED: 3, PENDED_REVOKE: 4, CANCELED: 5 };

async function setup() {
  const adminAg = agent();
  const { user: admin } = await registerAdmin(adminAg);
  const companyId = admin.companyId;
  const lt = await holidayType(companyId);
  const { email: empEmail, password: empPass, user: emp } = await addEmployee(adminAg, companyId);
  const empAg = agent();
  await login(empAg, empEmail, empPass);
  return { adminAg, admin, companyId, lt, emp, empAg };
}

async function approve(adminAg, leaveId) {
  const res = await postForm(adminAg, '/requests/approve/', { request: String(leaveId) });
  assert.ok([302, 303].includes(res.status), 'approve redirect');
}

describe('leave functional flows (real DB assertions)', () => {
  it('employee books leave -> pending (status 1) persisted', async () => {
    const s = await setup();
    const leave = await bookLeave(s.empAg, { leaveTypeId: s.lt.id, userId: s.emp.id, from: '2026-12-01', to: '2026-12-03' });
    assert.ok(leave, 'leave created in DB');
    assert.strictEqual(leave.status, S.NEW);
    assert.strictEqual(leave.userId, s.emp.id);
    assert.strictEqual(leave.leaveTypeId, s.lt.id);
    assert.strictEqual(leave.day_part_start, 1);
  });

  it('admin approves -> status 2 and approverId set', async () => {
    const s = await setup();
    const leave = await bookLeave(s.empAg, { leaveTypeId: s.lt.id, userId: s.emp.id, from: '2026-12-01', to: '2026-12-02' });
    await approve(s.adminAg, leave.id);
    const r = await db.Leave.findByPk(leave.id);
    assert.strictEqual(r.status, S.APPROVED);
    assert.strictEqual(r.approverId, s.admin.id);
  });

  it('admin rejects -> status 3', async () => {
    const s = await setup();
    const leave = await bookLeave(s.empAg, { leaveTypeId: s.lt.id, userId: s.emp.id, from: '2026-12-01', to: '2026-12-01' });
    const res = await postForm(s.adminAg, '/requests/reject/', { request: String(leave.id) });
    assert.ok([302, 303].includes(res.status));
    const r = await db.Leave.findByPk(leave.id);
    assert.strictEqual(r.status, S.REJECTED);
  });

  it('employee cancels a pending leave -> status 5', async () => {
    const s = await setup();
    const leave = await bookLeave(s.empAg, { leaveTypeId: s.lt.id, userId: s.emp.id, from: '2026-12-01', to: '2026-12-01' });
    assert.strictEqual(leave.status, S.NEW, 'leave starts pending');
    const res = await postForm(s.empAg, '/requests/cancel/', { request: String(leave.id) });
    assert.ok([302, 303].includes(res.status));
    const r = await db.Leave.findByPk(leave.id);
    assert.strictEqual(r.status, S.CANCELED);
  });

  it('employee revokes an approved leave -> status 4 (pended revoke)', async () => {
    const s = await setup();
    const leave = await bookLeave(s.empAg, { leaveTypeId: s.lt.id, userId: s.emp.id, from: '2026-12-01', to: '2026-12-01' });
    await approve(s.adminAg, leave.id);
    const res = await postForm(s.empAg, '/requests/revoke/', { request: String(leave.id) });
    assert.ok([302, 303].includes(res.status));
    const r = await db.Leave.findByPk(leave.id);
    assert.strictEqual(r.status, S.PENDED_REVOKE);
  });

  it('half-day (morning) booking stores day_part_start=2 and deducts 0.5', async () => {
    const s = await setup();
    const leave = await bookLeave(s.empAg, { leaveTypeId: s.lt.id, userId: s.emp.id, from: '2026-12-10', to: '2026-12-10', fromPart: 2, toPart: 2 });
    assert.ok(leave, 'half-day leave created');
    assert.strictEqual(leave.day_part_start, 2);
    await approve(s.adminAg, leave.id);
    const emp = await db.User.findByPk(s.emp.id);
    const allow = await emp.promise_allowance({});
    const avail = allow.number_of_days_available_in_allowance;
    assert.ok(Math.abs(avail - 19.5) < 0.01, `expected 19.5 available, got ${avail}`);
  });

  it('full-day approved leave reduces available allowance by 1', async () => {
    const s = await setup();
    const emp0 = await db.User.findByPk(s.emp.id);
    const a0 = (await emp0.promise_allowance({})).number_of_days_available_in_allowance;
    const leave = await bookLeave(s.empAg, { leaveTypeId: s.lt.id, userId: s.emp.id, from: '2026-12-01', to: '2026-12-01' });
    await approve(s.adminAg, leave.id);
    const emp1 = await db.User.findByPk(s.emp.id);
    const a1 = (await emp1.promise_allowance({})).number_of_days_available_in_allowance;
    assert.ok(Math.abs((a0 - a1) - 1) < 0.01, `expected delta 1, got ${a0 - a1}`);
  });

  it('overlapping booking is rejected (no new leave persisted)', async () => {
    const s = await setup();
    const l1 = await bookLeave(s.empAg, { leaveTypeId: s.lt.id, userId: s.emp.id, from: '2026-12-01', to: '2026-12-03' });
    await approve(s.adminAg, l1.id);
    const before = await db.Leave.count({ where: { userId: s.emp.id } });
    const l2 = await bookLeave(s.empAg, { leaveTypeId: s.lt.id, userId: s.emp.id, from: '2026-12-02', to: '2026-12-04' });
    assert.strictEqual(l2, null, 'overlapping leave not created');
    const after = await db.Leave.count({ where: { userId: s.emp.id } });
    assert.strictEqual(after, before, 'leave count unchanged');
  });

  it('auto-approve employee skips approval (status 2 on creation)', async () => {
    const adminAg = agent();
    const { user: admin } = await registerAdmin(adminAg);
    const lt = await holidayType(admin.companyId);
    const { user: emp } = await addEmployee(adminAg, admin.companyId, { auto_approve: true });
    const empAg = agent();
    await login(empAg, emp.email);
    const leave = await bookLeave(empAg, { leaveTypeId: lt.id, userId: emp.id, from: '2026-12-01', to: '2026-12-01' });
    assert.ok(leave);
    assert.strictEqual(leave.status, S.APPROVED);
  });
});

describe('role permissions', () => {
  it('non-admin employee cannot access settings (303 redirect)', async () => {
    const s = await setup();
    const res = await s.empAg.get('/settings/');
    assert.strictEqual(res.status, 303);
  });

  it('employee cannot approve their own leave (status unchanged)', async () => {
    const s = await setup();
    const leave = await bookLeave(s.empAg, { leaveTypeId: s.lt.id, userId: s.emp.id, from: '2026-12-01', to: '2026-12-01' });
    await postForm(s.empAg, '/requests/approve/', { request: String(leave.id) });
    const r = await db.Leave.findByPk(leave.id);
    assert.strictEqual(r.status, S.NEW, 'own leave still pending');
  });

  it('admin can access settings (200)', async () => {
    const s = await setup();
    const res = await s.adminAg.get('/settings/');
    assert.strictEqual(res.status, 200);
  });
});
