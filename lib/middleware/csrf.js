'use strict';

/*
 * CSRF protection (session synchronizer token pattern).
 *
 * - A random token is stored in the session and exposed to views as
 *   `csrf_token` (inject `<input type="hidden" name="_csrf" value="{{csrf_token}}">`
 *   into every POST form).
 * - Unsafe methods (POST/PUT/PATCH/DELETE) must present the token via the `_csrf`
 *   body field (urlencoded) or the `X-CSRF-Token` header (AJAX). Constant-time compare.
 * - Tokens are NEVER accepted from the URL/query string: URLs end up in access
 *   logs, browser history and Referer headers, which would leak the token.
 * - Multipart forms: the body is parsed later by Formidable, so global validation
 *   is deferred and the route MUST validate the parsed `_csrf` field with
 *   assertMultipartCsrf(req, fields). The token travels in the multipart body,
 *   not the URL.
 * - Bearer-token API (/integration/v1/) and public feeds (/feed/) are exempt
 *   (they are not cookie-authenticated).
 */

const crypto = require('crypto');

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];
const EXEMPT_PREFIXES = ['/integration/v1/', '/feed/'];

// Multipart bodies are parsed by Formidable inside the route, after this
// middleware runs, so the token cannot be validated here. Only routes that
// actually need multipart may defer it (they MUST call assertMultipartCsrf on
// the parsed fields). Any other endpoint sending multipart is rejected, so a
// plain form cannot be re-encoded as multipart to skip the CSRF check.
const MULTIPART_PATHS = ['/users/import/'];

function timingSafeMatch(sent, expected) {
  if (!sent || !expected || typeof sent !== 'string' || sent.length !== expected.length) return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function csrfProtection(req, res, next) {
  if (!req.session) return next();

  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  res.locals.csrf_token = req.session.csrfToken;

  if (SAFE_METHODS.includes(req.method)) return next();

  const path = req.path || req.url || '';
  if (EXEMPT_PREFIXES.some((p) => path.startsWith(p))) return next();

  const contentType = req.headers['content-type'] || '';
  if (/multipart\/form-data/i.test(contentType)) {
    if (!MULTIPART_PATHS.some((p) => path === p || path.startsWith(p))) {
      // This endpoint does not accept multipart: rejecting is the only safe
      // answer, because the body is not parsed and no token was validated.
      return res.status(403).send('Invalid or missing CSRF token');
    }
    // Body not parsed yet; the route validates the parsed _csrf field.
    req.csrfMultipartDeferred = true;
    return next();
  }

  const sent = (req.body && req.body._csrf) || req.headers['x-csrf-token'];
  if (!timingSafeMatch(sent, req.session.csrfToken)) {
    return res.status(403).send('Invalid or missing CSRF token');
  }
  return next();
}

// Validate the _csrf field parsed from a multipart body (route-level).
function assertMultipartCsrf(req, fields) {
  const raw = fields && fields._csrf;
  const sent = Array.isArray(raw) ? raw[0] : raw;
  const expected = req.session && req.session.csrfToken;
  return timingSafeMatch(sent, expected);
}

module.exports = csrfProtection;
module.exports.assertMultipartCsrf = assertMultipartCsrf;
