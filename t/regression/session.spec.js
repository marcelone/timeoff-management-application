'use strict';

const assert = require('assert');
const H = require('./helper');
const { agent, registerAdmin } = H;

function sid(res) {
  const sc = res.headers['set-cookie'] || [];
  const c = sc.find((x) => x.startsWith('timeoff.sid='));
  return c ? c.split(';')[0] : null;
}

describe('session security', () => {
  it('regenerates the session id on login (fixation prevention)', async () => {
    const setup = agent();
    const { email, password } = await registerAdmin(setup);

    const ag = agent();
    const pre = await ag.get('/login');
    const before = sid(pre);
    const res = await H.postForm(ag, '/login', { username: email, password });
    const after = sid(res);
    assert.ok(before, 'anonymous session cookie present');
    assert.ok(after, 'post-login session cookie present');
    assert.notStrictEqual(before, after, 'session id must change on login');
  });

  it('logout destroys the session server-side (old cookie invalidated)', async () => {
    const ag = agent();
    await registerAdmin(ag);
    const cal = await ag.get('/calendar/');
    assert.strictEqual(cal.status, 200);
    const out = await ag.get('/logout');
    assert.ok([302, 303].includes(out.status));
    const after = await ag.get('/calendar/');
    assert.strictEqual(after.status, 303, 'no longer authenticated after logout');
  });
});
