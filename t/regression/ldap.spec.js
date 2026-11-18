'use strict';

const assert = require('assert');
const LdapAuthenticator = require('../../lib/ldap');
const { escapeFilterValue } = LdapAuthenticator;

// Protocol-faithful mock of the ldapts Client surface used by the wrapper.
// Simulates: service bind, user search by filter, user bind (password check),
// invalid credentials, connection failures, and unbind.
function makeMockClient(directory, opts = {}) {
  return class MockClient {
    constructor(config) {
      this.config = config;
      this.lastFilter = null;
      this.boundDn = null;
    }
    async bind(dn, password) {
      if (opts.failConnect) {
        const e = new Error('Connection failed');
        e.name = 'ConnectionError';
        throw e;
      }
      if (dn === opts.serviceDn) {
        if (password !== opts.servicePassword) {
          const e = new Error('Invalid Credentials');
          e.name = 'InvalidCredentialsError';
          throw e;
        }
        this.boundDn = dn;
        return;
      }
      const entry = Object.values(directory).find((u) => u.dn === dn);
      if (!entry || entry.password !== password) {
        const e = new Error('Invalid Credentials');
        e.name = 'InvalidCredentialsError';
        throw e;
      }
      this.boundDn = dn;
    }
    async search(base, { filter }) {
      this.lastFilter = filter;
      const entries = Object.entries(directory)
        .filter(([email]) => filter.includes(escapeFilterValue(email)))
        .map(([, u]) => ({ dn: u.dn }));
      return { searchEntries: entries };
    }
    async unbind() {
      this.boundDn = null;
    }
  };
}

const DIR = {
  'alice@example.com': { dn: 'uid=alice,dc=example,dc=com', password: 'alice-secret' },
};
const OPTS = { serviceDn: 'cn=svc,dc=example,dc=com', servicePassword: 'svc-secret' };
const CFG = {
  url: 'ldaps://ldap.example.com:636',
  bindDn: OPTS.serviceDn,
  bindCredentials: OPTS.servicePassword,
  searchBase: 'dc=example,dc=com',
  searchFilter: '(mail={{username}})',
};

function auth(clientOpts = {}, cfg = CFG) {
  const Mock = makeMockClient(DIR, Object.assign({}, OPTS, clientOpts));
  return new LdapAuthenticator(cfg, Mock);
}

function authenticate(a, username, password) {
  return new Promise((resolve) => {
    a.authenticate(username, password, (err, user) => resolve({ err, user }));
  });
}

describe('LDAP authenticator (protocol-faithful mock)', () => {
  it('authenticates with correct credentials', async () => {
    const a = auth();
    const { err, user } = await authenticate(a, 'alice@example.com', 'alice-secret');
    assert.ok(!err, 'no error');
    assert.strictEqual(user.dn, DIR['alice@example.com'].dn);
  });

  it('wrong password calls cb(err) and does NOT crash (no error listener)', async () => {
    const a = auth();
    assert.strictEqual(a.listenerCount('error'), 0, 'no listener registered');
    const { err, user } = await authenticate(a, 'alice@example.com', 'WRONG');
    assert.ok(err, 'error delivered via callback');
    assert.strictEqual(err.name, 'InvalidCredentialsError');
    assert.ok(!user);
    // If an uncaught 'error' had been emitted, the process/test would have crashed.
  });

  it('connection failure is handled via callback (no crash)', async () => {
    const a = auth({ failConnect: true });
    const { err } = await authenticate(a, 'alice@example.com', 'alice-secret');
    assert.ok(err);
    assert.strictEqual(err.name, 'ConnectionError');
  });

  it('unknown user yields USER_NOT_FOUND via callback', async () => {
    const a = auth();
    const { err } = await authenticate(a, 'nobody@example.com', 'x');
    assert.ok(err);
    assert.strictEqual(err.code, 'USER_NOT_FOUND');
  });

  it('escapes LDAP filter special characters (injection prevented)', async () => {
    const a = auth();
    const injected = 'alice@example.com)(mail=*))(|(mail=*';
    await authenticate(a, injected, 'x');
    // The mock captured the filter on the service client search; re-run to capture:
    let captured = null;
    const Mock = makeMockClient(DIR, OPTS);
    const spy = new LdapAuthenticator(CFG, class extends Mock {
      async search(base, o) { captured = o.filter; return super.search(base, o); }
    });
    await authenticate(spy, injected, 'x');
    assert.ok(captured, 'filter captured');
    assert.ok(!captured.includes(')(mail=*'), 'raw injection not present');
    assert.ok(captured.includes('\\28') && captured.includes('\\29') && captured.includes('\\2a'), 'special chars escaped');
  });

  it('emits error only when a listener is registered (settings path)', async () => {
    const a = auth();
    let emitted = null;
    a.on('error', (e) => { emitted = e; });
    const { err } = await authenticate(a, 'alice@example.com', 'WRONG');
    assert.ok(err);
    assert.ok(emitted, 'error emitted to registered listener');
  });

  it('TLS verification is ON by default; opt-out is explicit', () => {
    const secure = new LdapAuthenticator(CFG, makeMockClient(DIR, OPTS));
    assert.strictEqual(secure.tlsOptions.rejectUnauthorized, true);
    const optedOut = new LdapAuthenticator(
      Object.assign({}, CFG, { tlsOptions: { rejectUnauthorized: false } }),
      makeMockClient(DIR, OPTS)
    );
    assert.strictEqual(optedOut.tlsOptions.rejectUnauthorized, false);
  });

  it('error messages do not contain credentials', async () => {
    const a = auth();
    const { err } = await authenticate(a, 'alice@example.com', 'alice-secret-WRONG');
    assert.ok(err);
    assert.ok(!String(err.message).includes('alice-secret'), 'password not in message');
    assert.ok(!String(err.message).includes('svc-secret'), 'bind credentials not in message');
  });

  it('escapeFilterValue escapes RFC4515 specials', () => {
    assert.strictEqual(escapeFilterValue('a(b)c*d\\e'), 'a\\28b\\29c\\2ad\\5ce');
  });
});
