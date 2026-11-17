'use strict';

/*
 * Phase 1 regression smoke suite (baseline lock).
 *
 * Goals:
 *   - Prove the recovered application boots and serves its core flows.
 *   - Lock CURRENT behaviour (including known quirks) so Phase 2/3 changes
 *     can be diffed against a green baseline.
 *
 * Design constraints:
 *   - ZERO new dependencies: uses only node:http, node:fs, node:path, node:os.
 *   - Boots the real app in-process (require('../../app')) on an ephemeral port.
 *   - Uses an isolated SQLite database in a fresh temp cwd, so it never touches
 *     a real/development database.
 *
 * Run (inside the recovery container / any env with installed node_modules):
 *   NODE_ENV=development node t/regression/smoke.js
 *
 * Exit code 0 = all assertions passed, 1 = at least one failure.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = process.env.REPO_ROOT || path.resolve(__dirname, '..', '..');

// Isolate the SQLite file WITHOUT changing cwd (Express resolves views/ from cwd).
// Mutate the cached db.json config so Sequelize uses an absolute temp storage path.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'timeoff-regression-'));
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
const dbCfg = require(path.join(REPO_ROOT, 'config', 'db.json'));
const envCfg = dbCfg[process.env.NODE_ENV] || dbCfg.development;
envCfg.storage = path.join(TMP, 'regression.sqlite');

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: detail || '' });
  const tag = cond ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name}${detail ? ' :: ' + detail : ''}`);
}

// Minimal cookie-aware HTTP client (no external deps).
function makeClient() {
  const jar = new Map();
  function cookieHeader() {
    return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  }
  function storeCookies(res) {
    const sc = res.headers['set-cookie'] || [];
    for (const line of sc) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }
  function request(method, urlPath, { form, follow } = {}) {
    return new Promise((resolve, reject) => {
      const body = form ? new URLSearchParams(form).toString() : null;
      const headers = {};
      const c = cookieHeader();
      if (c) headers.Cookie = c;
      if (body) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        headers['Content-Length'] = Buffer.byteLength(body);
      }
      const req = http.request(
        { host: '127.0.0.1', port: PORT, path: urlPath, method, headers },
        (res) => {
          storeCookies(res);
          let data = '';
          res.on('data', (d) => (data += d));
          res.on('end', () => {
            const out = { status: res.statusCode, headers: res.headers, body: data };
            if (follow && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
              const base = `http://127.0.0.1:${PORT}${urlPath}`;
              const loc = new URL(res.headers.location, base).pathname;
              return resolve(request('GET', loc, { follow: false }).then((n) => {
                n.redirectedFrom = urlPath; n.finalPath = loc; return n;
              }));
            }
            resolve(out);
          });
        }
      );
      req.on('error', reject);
      req.setTimeout(15000, () => req.destroy(new Error('timeout')));
      if (body) req.write(body);
      req.end();
    });
  }
  return { request, jar };
}

let PORT;
let server;
let app;

async function main() {
  app = require(path.join(REPO_ROOT, 'app'));
  // Pin views to the repo so rendering is independent of process.cwd().
  app.set('views', path.join(REPO_ROOT, 'views'));
  const db = app.get('db_model');
  await db.sequelize.sync();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  PORT = server.address().port;
  console.log(`# app listening on 127.0.0.1:${PORT}, db=${envCfg.storage}`);

  const guest = makeClient();
  const user = makeClient();
  const email = `regression-${Date.now()}@example.test`;
  const password = 'Sup3rSecret!';

  // 1. Login page renders.
  let r = await guest.request('GET', '/login');
  check('GET /login returns 200', r.status === 200, `status=${r.status}`);
  check('login page branded', /Time Off Management/.test(r.body));

  // 2. Registration creates company + admin and auto-logs-in.
  r = await user.request('POST', '/register', {
    form: {
      email, name: 'Reg', lastname: 'Ression', company_name: 'RegressionCo',
      password, password_confirmed: password, country: 'es', timezone: 'Europe/Madrid',
    },
  });
  check('POST /register redirects (302)', r.status === 302, `status=${r.status} loc=${r.headers.location}`);

  // 3. Authenticated root redirects to calendar and renders it.
  r = await user.request('GET', '/', { follow: true });
  check('authenticated GET / lands on Calendar (200)', r.status === 200 && /Calendar/.test(r.body),
    `status=${r.status} final=${r.finalPath}`);

  // 4. Explicit login with correct credentials succeeds.
  const loginClient = makeClient();
  r = await loginClient.request('POST', '/login', { form: { username: email, password } });
  check('POST /login correct -> 302 /', r.status === 302 && r.headers.location === '/',
    `status=${r.status} loc=${r.headers.location}`);
  r = await loginClient.request('GET', '/', { follow: true });
  check('login session reaches Calendar', r.status === 200 && /Calendar/.test(r.body), `status=${r.status}`);

  // 5. Wrong password is rejected back to /login.
  const badClient = makeClient();
  r = await badClient.request('POST', '/login', { form: { username: email, password: 'wrong-password' } });
  check('POST /login wrong -> 302 /login', r.status === 302 && /\/login/.test(r.headers.location || ''),
    `status=${r.status} loc=${r.headers.location}`);

  // 6. Access control: guests cannot reach protected pages.
  r = await guest.request('GET', '/calendar/');
  check('guest /calendar/ blocked (303)', r.status === 303, `status=${r.status}`);
  r = await guest.request('GET', '/settings/');
  check('guest /settings/ blocked (303)', r.status === 303, `status=${r.status}`);
  r = await guest.request('GET', '/users/');
  check('guest /users/ blocked (303)', r.status === 303, `status=${r.status}`);

  // 7. Notifications API works for authenticated user (empty initially).
  r = await user.request('GET', '/api/v1/notifications/');
  let notifOk = false; let notifDetail = `status=${r.status}`;
  try { const j = JSON.parse(r.body); notifOk = r.status === 200 && Array.isArray(j.data); notifDetail += ` data=${JSON.stringify(j.data)}`; } catch (e) { notifDetail += ' parse-error'; }
  check('GET /api/v1/notifications/ returns JSON data[]', notifOk, notifDetail);

  // 8. Public feed with unknown token: CURRENT behaviour is 200 "N/A" (known quirk, should be 404).
  r = await guest.request('GET', '/feed/unknown-token/ical.ics');
  check('feed unknown token -> 200 "N/A" (baseline quirk)', r.status === 200 && r.body.trim() === 'N/A',
    `status=${r.status} body=${r.body.trim().slice(0, 20)}`);

  // 9. Integration API rejects missing bearer token.
  r = await guest.request('GET', '/integration/v1/');
  check('integration API without token -> 401', r.status === 401, `status=${r.status}`);

  // 10. Password stored as legacy MD5 hex (baseline lock; Phase 2 will migrate to bcrypt/argon2).
  const crypto = require('crypto');
  const cfg = require(path.join(REPO_ROOT, 'lib', 'config'));
  const expectedMd5 = crypto.createHash('md5')
    .update(password + cfg.get('crypto_secret'), (cfg.get('crypto_hash_encoding') || 'binary'))
    .digest('hex');
  const row = await db.User.find({ where: { email } });
  check('password hash is legacy MD5 (baseline)', row && row.password === expectedMd5,
    `stored=${row ? row.password.slice(0, 12) : 'none'}…`);

  await db.sequelize.close();
  await new Promise((resolve) => server.close(resolve));
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n# SUMMARY: ${results.length - failed.length}/${results.length} passed`);
    if (failed.length) { console.log('# FAILED: ' + failed.map((f) => f.name).join(' | ')); }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
    process.exit(failed.length ? 1 : 0);
  })
  .catch((err) => {
    console.error('# FATAL', err);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
    process.exit(1);
  });
