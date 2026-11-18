'use strict';

const assert = require('assert');
const { agent, registerAdmin, login, postForm, db } = require('./helper');

describe('auth & security', () => {
  it('registers a company admin with bcrypt and reaches the calendar', async () => {
    const ag = agent();
    const { user } = await registerAdmin(ag);
    assert.ok(user.password.startsWith('$2b$'), 'password stored as bcrypt');
    const root = await ag.get('/');
    assert.strictEqual(root.status, 302);
    assert.ok(root.headers.location.includes('calendar'), 'redirect to calendar');
    const cal = await ag.get('/calendar/');
    assert.strictEqual(cal.status, 200);
  });

  it('rejects registration without a CSRF token (403)', async () => {
    const ag = agent();
    await ag.get('/register'); // establish session
    const res = await ag.post('/register').type('form').send({
      email: 'nocsrf@test.local', name: 'No', lastname: 'Csrf', company_name: 'NoCo',
      password: 'Passw0rd!', password_confirmed: 'Passw0rd!', country: 'es', timezone: 'Europe/Madrid',
    });
    assert.strictEqual(res.status, 403);
  });

  it('accepts correct credentials and rejects wrong password', async () => {
    const ag = agent();
    const { email, password } = await registerAdmin(ag);
    const ok = agent();
    await login(ok, email, password);
    const bad = agent();
    const res = await postForm(bad, '/login', { username: email, password: 'WRONG' });
    assert.strictEqual(res.status, 302);
    assert.ok(res.headers.location.includes('/login'), 'wrong password back to login');
  });

  it('password reset uses a random expiring single-use token', async () => {
    const ag = agent();
    const { email } = await registerAdmin(ag);

    await postForm(ag, '/forgot-password/', { email });
    const u1 = await db.User.find_by_email(email);
    assert.ok(u1.reset_password_token, 'reset token issued');
    assert.ok(u1.reset_password_expires, 'expiry set');
    const token = u1.get_reset_password_token();

    const form = await ag.get('/reset-password/?t=' + token);
    assert.strictEqual(form.status, 200, 'reset form renders for valid token');

    const res = await postForm(ag, '/reset-password/', {
      t: token, password: 'NewPassw0rd!', confirm_password: 'NewPassw0rd!',
    });
    assert.strictEqual(res.status, 302);

    const u2 = await db.User.find_by_email(email);
    assert.strictEqual(u2.reset_password_token, null, 'token invalidated after reset');
    assert.ok(u2.password.startsWith('$2b$'), 'new password bcrypt');

    const ag2 = agent();
    await login(ag2, email, 'NewPassw0rd!');

    const reuse = await db.User.get_user_by_reset_password_token(token);
    assert.ok(!reuse, 'old token no longer valid');
  });
});
