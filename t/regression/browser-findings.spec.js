'use strict';

// Regression tests for defects found by real-browser (Playwright) verification
// that the HTTP-level suite could not see:
//  1. /audit/email/ threw 500 (validator.isInt on the numeric result of toInt).
//  2. Google Fonts stylesheet used a protocol-relative URL -> http:// blocked by
//     the CSP style-src (https only) on http deployments.
//  3. CSRF hidden inputs rendered INSIDE {{#each}} blocks resolved {{csrf_token}}
//     against the loop item (empty), so approve/reject forms posted no token (403).
//     Fixed by using {{@root.csrf_token}}.

const assert = require('assert');
const { agent, registerAdmin, addEmployee, login, holidayType, bookLeave, db } = require('./helper');

describe('Browser-verification findings (regression)', function () {

  describe('audit/email renders (isInt on a number no longer throws)', () => {
    it('returns 200 with no filter, a valid user_id, an invalid user_id and a date range', async () => {
      const ag = agent();
      const { user } = await registerAdmin(ag);
      for (const qs of ['', '?user_id=' + user.id, '?user_id=not-a-number', '?start_date=2026-01-01&end_date=2026-12-31']) {
        const res = await ag.get('/audit/email/' + qs);
        assert.strictEqual(res.status, 200, 'audit/email/' + qs + ' must render, got ' + res.status);
      }
    });
  });

  describe('CSP: external font stylesheet is explicit https', () => {
    it('layout uses https://fonts.googleapis.com (not protocol-relative) and CSP allows it', async () => {
      const ag = agent();
      const res = await ag.get('/login/');
      assert.strictEqual(res.status, 200);
      assert.ok(res.text.includes('href="https://fonts.googleapis.com'), 'font link must be explicit https');
      assert.ok(!res.text.includes('href="//fonts.googleapis.com'), 'no protocol-relative font URL (http would be CSP-blocked)');
      const csp = res.headers['content-security-policy'] || '';
      assert.ok(/style-src[^;]*https:\/\/fonts\.googleapis\.com/.test(csp), 'CSP style-src must allow the https font origin');
    });
  });

  describe('CSRF token is present in forms rendered inside {{#each}}', () => {
    it('requests approve/reject forms carry a non-empty session token for a pending leave', async () => {
      const adminAg = agent();
      const { user: admin } = await registerAdmin(adminAg);
      const emp = await addEmployee(adminAg, admin.companyId);
      const lt = await holidayType(admin.companyId);
      assert.ok(lt, 'holiday leave type exists');

      const empAg = agent();
      await login(empAg, emp.email, emp.password);
      const leave = await bookLeave(empAg, { leaveTypeId: lt.id, userId: emp.user.id, from: '2026-12-10', to: '2026-12-11' });
      assert.ok(leave, 'employee leave created (pending approval)');

      const res = await adminAg.get('/requests/');
      assert.strictEqual(res.status, 200);
      const m = res.text.match(/form action="\/requests\/reject\/"[\s\S]*?name="_csrf" value="([^"]*)"/);
      assert.ok(m, 'a pending leave renders a reject form');
      assert.ok(m[1] && m[1].length > 0, 'CSRF token inside {{#each}} must NOT be empty');
      assert.match(m[1], /^[0-9a-f]{48}$/, 'token is the 48-char hex session token');
    });
  });
});
