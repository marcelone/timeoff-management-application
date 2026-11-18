'use strict';

const assert = require('assert');
const H = require('./helper');
const { agent, registerAdmin, addEmployee, db } = H;
const { ROLES, can, roleOf } = require('../../lib/auth/permissions');
const { scopeByCompany, assertSameCompany } = require('../../lib/auth/tenant');
const { listModules, getModule, activeModules } = require('../../lib/modules');

describe('HR architecture foundations', () => {
  it('work centers are scoped to a company and link employees', async () => {
    const ag = agent();
    const { user: admin } = await registerAdmin(ag);
    const center = await db.WorkCenter.create({ name: 'HQ', address: 'Main St', companyId: admin.companyId });
    assert.ok(center.id);
    const { user: emp } = await addEmployee(ag, admin.companyId);
    emp.workCenterId = center.id;
    await emp.save();
    const reloaded = await db.User.findByPk(emp.id);
    assert.strictEqual(reloaded.workCenterId, center.id);
    const users = await center.getUsers();
    assert.ok(users.some((u) => u.id === emp.id), 'employee linked to center');
    // company scope helper
    const scoped = scopeByCompany(admin, {});
    assert.strictEqual(scoped.companyId, admin.companyId);
  });

  it('company has subscription-ready fields defaulted', async () => {
    const ag = agent();
    const { user: admin } = await registerAdmin(ag);
    const co = await db.Company.findByPk(admin.companyId);
    assert.strictEqual(co.plan, 'free');
    assert.strictEqual(co.subscription_status, 'active');
  });

  it('role-based permissions distinguish admin from employee', async () => {
    const ag = agent();
    const { user: admin } = await registerAdmin(ag);
    const { user: emp } = await addEmployee(ag, admin.companyId);
    assert.strictEqual(roleOf(admin), ROLES.ADMIN);
    assert.strictEqual(roleOf(emp), ROLES.EMPLOYEE);
    assert.ok(can(admin, 'company.settings'));
    assert.ok(!can(emp, 'company.settings'));
    assert.ok(can(admin, 'leaves.approve'));
    assert.ok(!can(emp, 'leaves.approve'));
    assert.ok(can(emp, 'leaves.request'));
  });

  it('tenant guard rejects cross-company records', async () => {
    const aAg = agent();
    const A = await registerAdmin(aAg, { company: 'GuardA' });
    const bAg = agent();
    const B = await registerAdmin(bAg, { company: 'GuardB' });
    const bRecord = await db.WorkCenter.create({ name: 'B-center', companyId: B.user.companyId });
    assert.throws(() => assertSameCompany(A.user, bRecord), /Cross-company/);
    const aRecord = await db.WorkCenter.create({ name: 'A-center', companyId: A.user.companyId });
    assert.doesNotThrow(() => assertSameCompany(A.user, aRecord));
  });

  it('module registry declares active and planned modules', () => {
    const ids = listModules().map((m) => m.id);
    assert.ok(ids.includes('absences'));
    assert.ok(ids.includes('payroll'));
    assert.strictEqual(getModule('absences').status, 'active');
    assert.strictEqual(getModule('time-tracking').status, 'planned');
    assert.ok(activeModules().every((m) => m.status === 'active'));
  });
});
