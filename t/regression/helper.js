'use strict';

/*
 * Test harness with HARD database isolation.
 *
 * NODE_ENV=test forces config/database.js to use a throwaway SQLite file in the
 * OS temp dir, regardless of any DB_* env vars. We additionally assert that the
 * resolved config is sqlite + temp before booting, so no environment can make a
 * test touch an external/production database.
 *
 * The real app is booted in-process; supertest drives it over HTTP (no port
 * needed). Schema is created via migrations (incl. Sessions), not sync().
 */

process.env.NODE_ENV = 'test';
// Tests drive many auth requests from a single IP; relax the auth rate limiter so
// the suite is not throttled. Rate limiting itself is a production protection.
process.env.RATE_LIMIT_MAX = '100000';

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const request = require('supertest');

const dbConfig = require('../../config/database');
assert.strictEqual(dbConfig.dialect, 'sqlite', 'TEST ISOLATION: dialect must be sqlite');
assert.ok(
  dbConfig.storage && dbConfig.storage.startsWith(os.tmpdir()),
  `TEST ISOLATION: storage must be under ${os.tmpdir()}, got ${dbConfig.storage}`
);

require('../../lib/promise-shim');
require('../../lib/validator-shim');

const app = require('../../app');
const db = require('../../lib/model/db');
const { runMigrations } = require('../../lib/migrate');

let initialized = false;
async function init() {
  if (initialized) return;
  await runMigrations(db.sequelize);
  initialized = true;
}

async function cleanup() {
  try { await db.sequelize.close(); } catch (e) { /* ignore */ }
  try { fs.unlinkSync(dbConfig.storage); } catch (e) { /* ignore */ }
}

function agent() {
  return request.agent(app);
}

// Fetch the current session's CSRF token (renders the login form, which carries it).
async function freshCsrf(ag) {
  const res = await ag.get('/login');
  const m = res.text.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(m, 'CSRF token must be present in login form');
  return m[1];
}

// POST a form with a fresh CSRF token for the agent's current session.
async function postForm(ag, url, data) {
  const token = await freshCsrf(ag);
  return ag.post(url).type('form').send(Object.assign({}, data, { _csrf: token }));
}

let seq = 0;
function uniqueEmail(prefix) {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}@example.com`;
}

async function registerAdmin(ag, opts = {}) {
  const email = opts.email || uniqueEmail('admin');
  const password = opts.password || 'Passw0rd!';
  const res = await postForm(ag, '/register', {
    email,
    name: opts.name || 'Admin',
    lastname: opts.lastname || 'Boss',
    company_name: opts.company || `Co-${seq}`,
    password,
    password_confirmed: password,
    country: opts.country || 'es',
    timezone: opts.timezone || 'Europe/Madrid',
  });
  assert.strictEqual(res.status, 302, `register should redirect, got ${res.status}`);
  const user = await db.User.find_by_email(email);
  assert.ok(user, 'admin user created in DB');
  return { email, password, user };
}

async function login(ag, email, password = 'Passw0rd!') {
  const res = await postForm(ag, '/login', { username: email, password });
  assert.strictEqual(res.status, 302, `login should redirect, got ${res.status}`);
  assert.strictEqual(res.headers.location, '/', 'login lands on /');
}

// Create an employee through the real UI route (admin agent).
async function addEmployee(adminAg, companyId, opts = {}) {
  const dept = await db.Department.findOne({ where: { companyId } });
  const email = opts.email || uniqueEmail('emp');
  const password = opts.password || 'Passw0rd!';
  const res = await postForm(adminAg, '/users/add/', {
    name: opts.name || 'Emp',
    lastname: opts.lastname || 'Loyee',
    email_address: email,
    department: String(dept.id),
    start_date: opts.start_date || '2026-01-01',
    end_date: '',
    adjustment: '',
    password_one: password,
    password_confirm: password,
    admin: opts.admin ? 'true' : 'false',
    auto_approve: opts.auto_approve ? 'true' : 'false',
  });
  assert.ok([302, 303].includes(res.status), `add employee redirect, got ${res.status}`);
  const user = await db.User.find_by_email(email);
  assert.ok(user, 'employee created in DB');
  return { email, password, user };
}

async function holidayType(companyId) {
  return db.LeaveType.findOne({ where: { companyId, name: 'Holiday' } });
}

// Book leave through the real UI route; returns the created Leave row (or null).
async function bookLeave(ag, { leaveTypeId, userId, from, to, fromPart = 1, toPart = 1, reason = 'test' }) {
  const before = await db.Leave.count({ where: { userId } });
  const res = await postForm(ag, '/calendar/bookleave/', {
    user: userId ? String(userId) : '',
    leave_type: String(leaveTypeId),
    from_date: from,
    from_date_part: String(fromPart),
    to_date: to,
    to_date_part: String(toPart),
    reason,
  });
  assert.ok([302, 303].includes(res.status), `bookleave redirect, got ${res.status}`);
  const after = await db.Leave.count({ where: { userId } });
  if (after === before) return null;
  return db.Leave.findOne({ where: { userId }, order: [['id', 'DESC']] });
}

module.exports = {
  app, db, request, agent, init, cleanup,
  freshCsrf, postForm, registerAdmin, login, addEmployee, holidayType, bookLeave, uniqueEmail,
};
