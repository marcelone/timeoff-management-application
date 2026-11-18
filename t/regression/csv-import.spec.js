'use strict';

const assert = require('assert');
const H = require('./helper');
const { agent, registerAdmin, freshCsrf, db } = H;

function csvBuffer(rows) {
  return Buffer.from(rows.join('\n'), 'utf8');
}

async function importCsv(ag, buffer, { withCsrf = true, filename = 'users.csv' } = {}) {
  const token = await freshCsrf(ag);
  const url = withCsrf ? `/users/import/?_csrf=${token}` : '/users/import/';
  return ag.post(url).attach('users_import', buffer, filename);
}

describe('CSV bulk import (multipart + CSRF)', () => {
  it('imports a valid CSV and persists employees in the acting company', async () => {
    const ag = agent();
    const { user: admin } = await registerAdmin(ag);
    const before = await db.User.count({ where: { companyId: admin.companyId } });
    const csv = csvBuffer([
      'email,lastname,name,department',
      `csv1-${Date.now()}@example.com,Lname,Fname,Sales`,
      `csv2-${Date.now()}@example.com,Lname2,Fname2,Sales`,
    ]);
    const res = await importCsv(ag, csv);
    assert.ok([302, 303].includes(res.status), `import redirect, got ${res.status}`);
    const after = await db.User.count({ where: { companyId: admin.companyId } });
    assert.strictEqual(after, before + 2, 'two employees persisted');
    const created = await db.User.findAll({ where: { companyId: admin.companyId, lastname: ['Lname', 'Lname2'] } });
    assert.strictEqual(created.length, 2);
    assert.ok(created.every((u) => u.companyId === admin.companyId), 'all in acting company');
  });

  it('rejects a multipart import without CSRF token (403)', async () => {
    const ag = agent();
    const { user: admin } = await registerAdmin(ag);
    const before = await db.User.count({ where: { companyId: admin.companyId } });
    const csv = csvBuffer(['email,lastname,name,department', `nocsrf-${Date.now()}@example.com,L,F,Sales`]);
    const res = await importCsv(ag, csv, { withCsrf: false });
    assert.strictEqual(res.status, 403, 'no CSRF -> 403');
    const after = await db.User.count({ where: { companyId: admin.companyId } });
    assert.strictEqual(after, before, 'no employee created');
  });

  it('rejects CSV with an unknown department (no partial persist)', async () => {
    const ag = agent();
    const { user: admin } = await registerAdmin(ag);
    const email = `baddept-${Date.now()}@example.com`;
    const csv = csvBuffer(['email,lastname,name,department', `${email},L,F,NoSuchDept`]);
    const res = await importCsv(ag, csv);
    assert.ok([302, 303].includes(res.status), 'handled redirect');
    const u = await db.User.find_by_email(email);
    assert.ok(!u, 'invalid-department row not persisted');
  });

  it('rejects an oversized file (>2MB) without persisting', async () => {
    const ag = agent();
    const { user: admin } = await registerAdmin(ag);
    const before = await db.User.count({ where: { companyId: admin.companyId } });
    const big = Buffer.alloc(2 * 1024 * 1024 + 1024, 'a');
    const res = await importCsv(ag, big);
    assert.ok([302, 303, 400, 413].includes(res.status), `oversize handled, got ${res.status}`);
    const after = await db.User.count({ where: { companyId: admin.companyId } });
    assert.strictEqual(after, before, 'no employee created from oversized file');
  });

  it('cannot import employees into another company', async () => {
    const aAg = agent();
    const A = await registerAdmin(aAg, { company: 'CsvA' });
    const bAg = agent();
    const B = await registerAdmin(bAg, { company: 'CsvB' });
    const bBefore = await db.User.count({ where: { companyId: B.user.companyId } });
    const email = `cross-${Date.now()}@example.com`;
    const csv = csvBuffer(['email,lastname,name,department', `${email},L,F,Sales`]);
    const res = await importCsv(aAg, csv);
    assert.ok([302, 303].includes(res.status));
    const u = await db.User.find_by_email(email);
    assert.ok(u, 'employee created');
    assert.strictEqual(u.companyId, A.user.companyId, 'belongs to acting company A');
    const deptA = await db.Department.findOne({ where: { companyId: A.user.companyId } });
    assert.strictEqual(u.DepartmentId, deptA.id, 'department scoped to A');
    const bAfter = await db.User.count({ where: { companyId: B.user.companyId } });
    assert.strictEqual(bAfter, bBefore, 'company B unchanged');
  });
});
