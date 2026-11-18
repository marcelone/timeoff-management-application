'use strict';

/*
 * LDAP authenticator backed by `ldapts` (maintained).
 *
 * Replaces `ldapauth-fork`, which depended on the decommissioned `ldapjs`.
 * Exposes the same interface the app expects:
 *   - authenticate(username, password, cb(err, user))
 *   - close()
 *   - EventEmitter 'error' events (used by settings validation)
 *
 * Flow: bind with the service account, search for the user DN by filter,
 * then bind as that DN with the supplied password to verify credentials.
 */

const { EventEmitter } = require('events');
const { Client } = require('ldapts');

class LdapAuthenticator extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.url = opts.url;
    this.bindDn = opts.bindDn;
    this.bindCredentials = opts.bindCredentials;
    this.searchBase = opts.searchBase;
    this.searchFilter = opts.searchFilter || '(mail={{username}})';
    this.tlsOptions = opts.tlsOptions || {};
  }

  _client() {
    return new Client({ url: this.url, tlsOptions: this.tlsOptions });
  }

  authenticate(username, password, cb) {
    const run = async () => {
      const admin = this._client();
      try {
        await admin.bind(this.bindDn, this.bindCredentials);
        const filter = this.searchFilter.replace(/\{\{username\}\}/g, username);
        const { searchEntries } = await admin.search(this.searchBase, {
          scope: 'sub',
          filter,
          attributes: ['dn'],
        });
        if (!searchEntries || !searchEntries.length) {
          throw new Error(`No such user: ${username}`);
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

    run()
      .then((user) => cb(null, user))
      .catch((err) => { this.emit('error', err); cb(err); });
  }

  close() {
    // Clients are created per authentication call; nothing persistent to close.
  }
}

module.exports = LdapAuthenticator;
