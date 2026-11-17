'use strict';

/*
 * Validator safety shim (transitional / defensive).
 *
 * validator >=13 throws `Expected a string but received a undefined` for
 * null/undefined inputs (assertString). The legacy code calls e.g.
 * validator.isNumeric(req.query['department']) directly on optional params,
 * which used to return false. This wraps validator's functions IN PLACE so
 * null/undefined yield safe defaults (predicates -> false, trims -> '',
 * toDate -> null, toInt/toFloat -> NaN, toBoolean -> false) instead of throwing.
 *
 * Because validator is a singleton module object, requiring this once at startup
 * protects every `require('validator')` consumer. New code should still guard
 * inputs explicitly. See docs/MODERNIZATION_PLAN.md.
 */

const validator = require('validator');

function safeDefault(name) {
  if (name === 'toDate') return null;
  if (name === 'toInt' || name === 'toFloat') return NaN;
  if (name === 'toBoolean') return false;
  if (['trim', 'ltrim', 'rtrim', 'escape', 'unescape', 'stripLow', 'whitelist', 'blacklist', 'normalizeEmail'].includes(name)) return '';
  return false; // is*, matches, contains, equals, ...
}

for (const name of Object.keys(validator)) {
  const orig = validator[name];
  if (typeof orig !== 'function') continue;
  if (orig.__guarded) continue;
  const wrapped = function (input, ...args) {
    if (input === null || input === undefined) return safeDefault(name);
    return orig.call(this, input, ...args);
  };
  wrapped.__guarded = true;
  validator[name] = wrapped;
}

module.exports = validator;
