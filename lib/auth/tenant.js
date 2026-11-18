'use strict';

/*
 * Tenant (company) isolation helpers.
 *
 * Every business record belongs to a company. These helpers centralize the
 * scoping/guards that were previously scattered across routes, so new modules
 * enforce isolation consistently. Verified by t/regression/isolation.spec.js.
 */

// Merge a company scope into a Sequelize where clause.
function scopeByCompany(user, where = {}) {
  return Object.assign({}, where, { companyId: user.companyId });
}

// Express middleware: require an authenticated user bound to a company.
function ensureTenant(req, res, next) {
  if (!req.user || !req.user.companyId) return res.redirect_with_session(303, '/');
  return next();
}

// Throw if a record does not belong to the acting user's company.
function assertSameCompany(user, record) {
  if (!record || String(record.companyId) !== String(user.companyId)) {
    const err = new Error(`Cross-company access denied: user ${user && user.id} -> record company ${record && record.companyId}`);
    err.user_error_message = 'No access to given record';
    err.tom_error = true;
    throw err;
  }
  return record;
}

module.exports = { scopeByCompany, ensureTenant, assertSameCompany };
