'use strict';

/*
 * CSRF protection (session synchronizer token pattern).
 *
 * - A random token is stored in the session and exposed to views as
 *   `csrf_token` (inject `<input type="hidden" name="_csrf" value="{{csrf_token}}">`
 *   into every POST form).
 * - Unsafe methods (POST/PUT/PATCH/DELETE) must present the token via `_csrf`
 *   body field, `X-CSRF-Token` header, or `_csrf` query param (multipart); constant time.
 * - Bearer-token API (/integration/v1/) and public feeds (/feed/) are exempt
 *   (they are not cookie-authenticated).
 */

const crypto = require('crypto');

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];
const EXEMPT_PREFIXES = ['/integration/v1/', '/feed/'];

module.exports = function csrfProtection(req, res, next) {
  if (!req.session) return next();

  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  res.locals.csrf_token = req.session.csrfToken;

  if (SAFE_METHODS.includes(req.method)) return next();

  const path = req.path || req.url || '';
  if (EXEMPT_PREFIXES.some((p) => path.startsWith(p))) return next();

  // Token sources: parsed body (urlencoded), X-CSRF-Token header (AJAX), or
  // query string (multipart forms, whose body is parsed later by Formidable).
  const sent = (req.body && req.body._csrf) || req.headers['x-csrf-token'] || (req.query && req.query._csrf);
  const expected = req.session.csrfToken;

  if (!sent || typeof sent !== 'string' || sent.length !== expected.length) {
    return res.status(403).send('Invalid or missing CSRF token');
  }
  const a = Buffer.from(sent);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).send('Invalid or missing CSRF token');
  }
  return next();
};
