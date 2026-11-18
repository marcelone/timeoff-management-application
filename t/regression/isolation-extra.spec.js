'use strict';

const assert = require('assert');
const H = require('./helper');
const { agent, registerAdmin, addEmployee, freshCsrf, db } = H;

async function api(ag, method, url, body) {
  const token = await freshCsrf(ag);
  let req = ag[method](url).set('X-CSRF-Token', token);
  if (body) req = req.send(body);
  return req;
}

describe('multi-tenant isolation — work centers & departments (negative, DB-checked)', () => {
  it('employee cannot be associated to a work center of another company', async () => {
    const aAg = agent();
    const A = await registerAdmin(aAg, { company: 'WcA' });
    const bAg = agent();
    const B = await registerAdmin(bAg, { company: 'WcB' });
    const { user: emp } = await addEmployee(aAg, A.user.companyId);
    const bCenter = await db.WorkCenter.create({ name: 'B-HQ', companyId: B.user.companyId });

    emp.workCenterId = bCenter.id;
    let threw = null;
    try { await emp.save(); } catch (e) { threw = e; }
    assert.ok(threw, 'cross-company work center association rejected');
    const reloaded = await db.User.findByPk(emp.id);
    assert.ok(reloaded.workCenterId == null, 'association not persisted');

    // same-company center is allowed
    const aCenter = await db.WorkCenter.create({ name: 'A-HQ', companyId: A.user.companyId });
    emp.workCenterId = aCenter.id;
    await emp.save();
    const ok = await db.User.findByPk(emp.id);
    assert.strictEqual(ok.workCenterId, aCenter.id);
  });

  it('work center API lists/creates only within the acting company', async () => {
    const aAg = agent();
    const A = await registerAdmin(aAg, { company: 'ApiA' });
    const bAg = agent();
    const B = await registerAdmin(bAg, { company: 'ApiB' });
    await db.WorkCenter.create({ name: 'B-center', companyId: B.user.companyId });

    const created = await api(aAg, 'post', '/api/v1/workcenters', { name: 'A-center' });
    assert.strictEqual(created.status, 201);
    assert.strictEqual(created.body.data.companyId, A.user.companyId);

    const list = await aAg.get('/api/v1/workcenters');
    assert.strictEqual(list.status, 200);
    const names = list.body.data.map((c) => c.name);
    assert.ok(names.includes('A-center'));
    assert.ok(!names.includes('B-center'), 'B center not listed for A');
  });

  it('work center API rejects cross-company update/delete by direct ID (no mutation)', async () => {
    const aAg = agent();
    await registerAdmin(aAg, { company: 'UpdA' });
    const bAg = agent();
    const B = await registerAdmin(bAg, { company: 'UpdB' });
    const bCenter = await db.WorkCenter.create({ name: 'B-orig', companyId: B.user.companyId });

    const upd = await api(aAg, 'put', `/api/v1/workcenters/${bCenter.id}`, { name: 'HACKED' });
    assert.strictEqual(upd.status, 404);
    const afterUpd = await db.WorkCenter.findByPk(bCenter.id);
    assert.strictEqual(afterUpd.name, 'B-orig', 'B center not modified');

    const del = await api(aAg, 'delete', `/api/v1/workcenters/${bCenter.id}`);
    assert.strictEqual(del.status, 404);
    const afterDel = await db.WorkCenter.findByPk(bCenter.id);
    assert.ok(afterDel, 'B center not deleted');
  });

  it('non-admin employee is denied work center management (403)', async () => {
    const aAg = agent();
    const A = await registerAdmin(aAg);
    const { email, password } = await addEmployee(aAg, A.user.companyId);
    const empAg = agent();
    await H.login(empAg, email, password);
    const res = await empAg.get('/api/v1/workcenters');
    assert.strictEqual(res.status, 403);
  });

  it('company A cannot delete or edit a department of company B by direct ID', async () => {
    const aAg = agent();
    await registerAdmin(aAg, { company: 'DeptA' });
    const bAg = agent();
    const B = await registerAdmin(bAg, { company: 'DeptB' });
    const bDept = await db.Department.create({ name: 'B-empty', companyId: B.user.companyId });

    const del = await H.postForm(aAg, `/settings/departments/delete/${bDept.id}/`, {});
    assert.ok([302, 303].includes(del.status));
    const stillThere = await db.Department.findByPk(bDept.id);
    assert.ok(stillThere, 'B department not deleted');

    const edit = await H.postForm(aAg, `/settings/departments/edit/${bDept.id}/`, {
      name: 'HACKED', allowance: '30', include_public_holidays: 'true',
    });
    assert.ok([302, 303].includes(edit.status));
    const afterEdit = await db.Department.findByPk(bDept.id);
    assert.strictEqual(afterEdit.name, 'B-empty', 'B department not modified');
  });
});
