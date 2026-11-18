'use strict';

/*
 * Authentication rate limiting (extracted for reuse and testability).
 * Applies to POST requests on the auth endpoints. Limits are env-configurable;
 * tests can instantiate a strict limiter to verify real 429 behavior.
 */

const rateLimit = require('express-rate-limit');

const AUTH_PATH = /^\/(login|register|forgot-password|reset-password)/;

function createAuthRateLimit(opts = {}) {
  const limiter = rateLimit({
    windowMs: opts.windowMs || parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
    max: opts.max || parseInt(process.env.RATE_LIMIT_MAX || '50', 10),
    standardHeaders: true,
    legacyHeaders: false,
  });
  return function authRateLimit(req, res, next) {
    if (req.method === 'POST' && AUTH_PATH.test(req.path)) {
      return limiter(req, res, next);
    }
    return next();
  };
}

module.exports = { createAuthRateLimit };
