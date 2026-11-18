'use strict';

// Regression tests for the four findings of the independent static security
// review: (P1) POST /register honours ALLOW_CREATE_NEW_ACCOUNTS, (P1) CSRF
// tokens are never accepted from the URL, (P2) server-side password policy on
// reset, (P2) session regeneration on registration.

const assert = require('assert');
const { db, agent, freshCsrf, postForm, registerAdmin } = require('./helper');
const config = require('../../lib/config');

const sidFrom = (res) => {
  const sc = res.headers['set-cookie'] || [];
  for (const c of sc) {
    const m = c.match(/timeoff\.sid=([^;]+)/);
    if (m) return m[1];
  }
  return null;
};

describe('Security review fixes (regression)', function () {
  describe('P1: public registration can be disabled', () => {
    it('blocks POST /register (not only GET) when allow_create_new_accounts=false', async () => {
      const prev = config.get('allow_create_new_accounts');
      config.set('allow_create_new_accounts', false);
      try {
        const ag = agent();
        const companiesBefore = await db.Company.count();
        const res = await postForm(ag, '/register/', {
          company_name: 'Blocked Co', name: 'A', lastname: 'B',
          email: 'blocked@example.com', password: 'password123',
          password_confirmed: 'password123', country: 'es', timezone: 'Europe/Madrid',
        });
        assert.strictEqual(res.status, 403, 'POST /register must be blocked too');
        assert.strictEqual(await db.Company.count(), companiesBefore, 'no company created');
        assert.ok(!(await db.User.find_by_email('blocked@example.com')), 'no user created');
        assert.strictEqual((await ag.get('/register/')).status, 403, 'GET also blocked');
      } finally {
        config.set('allow_create_new_accounts', prev);
      }
    });
  });

  describe('P1: CSRF tokens are never accepted from the URL', () => {
    it('rejects a valid token supplied via query string on a normal POST', async () => {
      const ag = agent();
      const token = await freshCsrf(ag);
      const res = await ag.post('/login/?_csrf=' + token)
        .type('form').send({ email: 'x@example.com', password: 'password123' });
      assert.strictEqual(res.status, 403, 'query-string CSRF token rejected');
    });

    it('CSV import rejects a query token but accepts a body token', async () => {
      const ag = agent();
      await registerAdmin(ag, { email: 'csrfcsv@example.com' });
      const token = await freshCsrf(ag);
      const csv = 'email,firstname,lastname,department\nbodytok@example.com,Bo,Dy,Sales\n';

      const bad = await ag.post('/users/import/?_csrf=' + token)
        .attach('users_import', Buffer.from(csv), 'u.csv');
      assert.strictEqual(bad.status, 403, 'query token rejected for multipart');

      const good = await ag.post('/users/import/')
        .attach('users_import', Buffer.from(csv), 'u.csv')
        .field('_csrf', token);
      assert.strictEqual(good.status, 302, 'body token accepted');
      assert.ok(await db.User.find_by_email('bodytok@example.com'), 'imported via body token');
    });

    it('CSV import without any token is rejected', async () => {
      const ag = agent();
      await registerAdmin(ag, { email: 'notokcsv@example.com' });
      const res = await ag.post('/users/import/')
        .attach('users_import', Buffer.from('email,firstname,lastname\nx@example.com,X,Y\n'), 'u.csv');
      assert.strictEqual(res.status, 403);
    });
  });

  describe('P2: server-side password policy on reset', () => {
    it('rejects empty and too-short passwords without changing the hash', async () => {
      const ag = agent();
      const { email } = await registerAdmin(ag, { email: 'resetpol@example.com' });
      await postForm(ag, '/forgot-password/', { email });
      const u = await db.User.find_by_email(email);
      const token = u.get_reset_password_token();
      const originalHash = u.password;

      for (const pw of ['', 'short', '1234567']) {
        const res = await postForm(ag, '/reset-password/', { t: token, password: pw, confirm_password: pw });
        assert.strictEqual(res.status, 302);
        assert.ok(res.headers.location.includes('/reset-password/'), 'back to reset form, not login');
        const after = await db.User.find_by_email(email);
        assert.strictEqual(after.password, originalHash, 'password unchanged for invalid input');
        assert.ok(after.reset_password_token, 'token still valid after a rejected attempt');
      }

      const ok = await postForm(ag, '/reset-password/', { t: token, password: 'ValidPass123', confirm_password: 'ValidPass123' });
      assert.ok(ok.headers.location.includes('/login/'), 'valid reset proceeds to login');
      const changed = await db.User.find_by_email(email);
      assert.notStrictEqual(changed.password, originalHash, 'valid password applied');
    });
  });

  describe('P2: registration regenerates the session (anti-fixation)', () => {
    it('issues a new session id when registration auto-logs-in', async () => {
      const ag = agent();
      const pre = await ag.get('/login/');
      const sidBefore = sidFrom(pre);
      const token = (pre.text.match(/name="_csrf" value="([^"]+)"/) || [])[1];
      assert.ok(sidBefore, 'pre-auth session established');

      const res = await ag.post('/register/').type('form').send({
        company_name: 'Regen Co', name: 'A', lastname: 'B',
        email: 'regen@example.com', password: 'password123',
        password_confirmed: 'password123', country: 'es', timezone: 'Europe/Madrid',
        _csrf: token,
      });
      assert.strictEqual(res.status, 302);
      const sidAfter = sidFrom(res);
      assert.ok(sidAfter, 'session cookie present after registration');
      assert.notStrictEqual(sidAfter, sidBefore, 'session id regenerated on registration');
    });
  });
});
