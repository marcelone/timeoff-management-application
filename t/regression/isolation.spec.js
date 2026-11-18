'use strict';

const assert = require('assert');
const H = require('./helper');
const { agent, registerAdmin, login, addEmployee, holidayType, bookLeave, postForm, db } = H;

async function twoCompanies() {
  const aAg = agent();
  const A = await registerAdmin(aAg, { company: 'AlphaCo' });
  const bAg = agent();
  const B = await registerAdmin(bAg, { company: 'BetaCo' });
  const ea = await addEmployee(aAg, A.user.companyId, { name: 'Alice', lastname: 'Alpha' });
  const eb = await addEmployee(bAg, B.user.companyId, { name: 'Bob', lastname: 'Beta' });
  return { aAg, A, bAg, B, ea, eb };
}

async function bookInB(bAg, B, eb) {
  const lt = await holidayType(B.user.companyId);
  const ebAg = agent();
  await login(ebAg, eb.email);
  const leave = await bookLeave(ebAg, { leaveTypeId: lt.id, userId: eb.user.id, from: '2026-12-01', to: '2026-12-01' });
  await postForm(bAg, '/requests/approve/', { request: String(leave.id) });
  return leave;
}

describe('tenant isolation (company A cannot read/modify company B)', () => {
  it('A user list does not expose B employees', async () => {
    const { aAg, eb } = await twoCompanies();
    const res = await aAg.get('/users/');
    assert.strictEqual(res.status, 200);
    assert.ok(!res.text.includes(eb.email), 'B employee email absent from A list');
  });

  it('A cannot view B user summary by direct ID', async () => {
    const { aAg, eb } = await twoCompanies();
    const res = await aAg.get('/users/summary/' + eb.user.id + '/');
    assert.ok(res.text.includes('Failed'), 'access denied');
    assert.ok(!res.text.includes(eb.email), 'no B data leaked');
  });

  it('A cannot edit B user by direct ID (no DB modification)', async () => {
    const { aAg, eb } = await twoCompanies();
    const deptB = await db.Department.findOne({ where: { companyId: eb.user.companyId } });
    await postForm(aAg, '/users/edit/' + eb.user.id + '/', {
      name: 'Hacked', lastname: 'X', email_address: eb.email,
      department: String(deptB.id), start_date: '2026-01-01', end_date: '',
      password_one: '', password_confirm: '', admin: 'false', auto_approve: 'false',
    });
    const after = await db.User.findByPk(eb.user.id);
    assert.strictEqual(after.name, 'Bob', 'B user name unchanged');
    assert.strictEqual(after.companyId, eb.user.companyId, 'B user company unchanged');
  });

  it('A cannot view B leave summary by direct ID', async () => {
    const { aAg, bAg, B, eb } = await twoCompanies();
    const leave = await bookInB(bAg, B, eb);
    const res = await aAg.get('/calendar/leave-summary/' + leave.id + '/');
    assert.ok(res.text.includes('Failed'), 'access denied');
  });

  it('A cannot revoke B leave by direct ID (no DB modification)', async () => {
    const { aAg, bAg, B, eb } = await twoCompanies();
    const leave = await bookInB(bAg, B, eb);
    const before = await db.Leave.findByPk(leave.id);
    await postForm(aAg, '/requests/revoke/', { request: String(leave.id) });
    const after = await db.Leave.findByPk(leave.id);
    assert.strictEqual(after.status, before.status, 'B leave status unchanged');
  });

  it('A cannot approve/reject B leave by direct ID (no DB modification)', async () => {
    const { aAg, bAg, B, eb } = await twoCompanies();
    const lt = await holidayType(B.user.companyId);
    const ebAg = agent();
    await login(ebAg, eb.email);
    const leave = await bookLeave(ebAg, { leaveTypeId: lt.id, userId: eb.user.id, from: '2026-12-05', to: '2026-12-05' });
    await postForm(aAg, '/requests/approve/', { request: String(leave.id) });
    const after = await db.Leave.findByPk(leave.id);
    assert.strictEqual(after.status, 1, 'B leave still pending (A could not approve)');
  });

  it('integration API: A bearer token returns only A data, never B', async () => {
    const { aAg, A, B, ea, eb } = await twoCompanies();
    await db.Company.update({ integration_api_enabled: true }, { where: { id: A.user.companyId } });
    await db.Company.update({ integration_api_enabled: true }, { where: { id: B.user.companyId } });
    const ca = await db.Company.findByPk(A.user.companyId);
    const res = await aAg.get('/integration/v1/report/allowance')
      .set('Authorization', 'Bearer ' + ca.integration_api_token);
    assert.strictEqual(res.status, 200);
    const body = JSON.stringify(res.body);
    assert.ok(body.includes(ea.email), 'A employee present in A API response');
    assert.ok(!body.includes(eb.email), 'B employee absent from A API response');
  });

  it('integration API rejects an invalid bearer token (401)', async () => {
    const { aAg } = await twoCompanies();
    const res = await aAg.get('/integration/v1/report/allowance')
      .set('Authorization', 'Bearer invalid-token-xyz');
    assert.strictEqual(res.status, 401);
  });
});
