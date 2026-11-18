'use strict';

/*
 * LDAP authenticator backed by `ldapts` (maintained).
 *
 * Replaces `ldapauth-fork` (decommissioned `ldapjs`). Interface used by the app:
 *   - authenticate(username, password, cb(err, user))
 *   - close()
 *   - optional EventEmitter 'error' events (settings validation registers one)
 *
 * Security properties:
 *   - TLS certificate verification ON by default (rejectUnauthorized: true).
 *     An operator may explicitly opt out via tlsOptions.rejectUnauthorized=false.
 *   - LDAP filter values are escaped (RFC 4515) to prevent filter injection.
 *   - 'error' is emitted ONLY when a listener is registered, so a failed auth
 *     never becomes an uncaught exception that crashes the process.
 *   - Error messages never include credentials (password / bind credentials).
 *   - The Client implementation is injectable for protocol-faithful testing.
 */

const { EventEmitter } = require('events');
const { Client } = require('ldapts');

// RFC 4515 filter value escaping.
function escapeFilterValue(value) {
  return String(value)
    .replace(/\\/g, '\\5c')
    .replace(/\*/g, '\\2a')
    .replace(/\(/g, '\\28')
    .replace(/\)/g, '\\29')
    .replace(/\0/g, '\\00')
    .replace(/\//g, '\\2f');
}

class LdapAuthenticator extends EventEmitter {
  constructor(opts = {}, ClientImpl = Client) {
    super();
    this._Client = ClientImpl;
    this.url = opts.url;
    this.bindDn = opts.bindDn;
    this.bindCredentials = opts.bindCredentials;
    this.searchBase = opts.searchBase;
    this.searchFilter = opts.searchFilter || '(mail={{username}})';
    // Secure by default; explicit opt-out only.
    this.tlsOptions = Object.assign({ rejectUnauthorized: true }, opts.tlsOptions || {});
  }

  _client() {
    return new this._Client({ url: this.url, tlsOptions: this.tlsOptions });
  }

  authenticate(username, password, cb) {
    let settled = false;
    const safeCb = (err, user) => {
      if (settled) return;
      settled = true;
      cb(err, user);
    };

    const run = async () => {
      const admin = this._client();
      try {
        await admin.bind(this.bindDn, this.bindCredentials);
        const filter = this.searchFilter.replace(/\{\{username\}\}/g, escapeFilterValue(username));
        const { searchEntries } = await admin.search(this.searchBase, {
          scope: 'sub',
          filter,
          attributes: ['dn'],
        });
        if (!searchEntries || !searchEntries.length) {
          const e = new Error('LDAP user not found');
          e.code = 'USER_NOT_FOUND';
          throw e;
        }
        const userDn = searchEntries[0].dn;
        const userClient = this._client();
        try {
          await userClient.bind(userDn, password);
        } finally {
          await userClient.unbind().catch(() => {});
        }
        return { dn: userDn, cn: username };
      } finally {
        await admin.unbind().catch(() => {});
      }
    };

    let promise;
    try {
      promise = run();
    } catch (err) {
      return safeCb(err);
    }

    promise
      .then((user) => safeCb(null, user))
      .catch((err) => {
        // Only emit if someone is listening; otherwise an 'error' event would
        // throw and crash the process. The callback always receives the error.
        if (this.listenerCount('error') > 0) {
          this.emit('error', err);
        }
        safeCb(err);
      });
  }

  close() {
    // Clients are created per authentication call; nothing persistent to close.
  }
}

module.exports = LdapAuthenticator;
module.exports.escapeFilterValue = escapeFilterValue;
