'use strict';

/*
 * Role-based access control foundation.
 *
 * Roles: owner > admin > manager > employee. The legacy `admin` boolean is kept
 * and mapped to the admin role so existing behavior is preserved while the
 * permission catalog becomes the single source of truth for authorization.
 *
 * New modules (time-tracking, shifts, payroll, ...) register their permissions
 * here and guard routes with requirePermission().
 */

const ROLES = {
  OWNER: 'owner',
  ADMIN: 'admin',
  MANAGER: 'manager',
  EMPLOYEE: 'employee',
};

// permission -> roles allowed
const PERMISSIONS = {
  'company.settings': [ROLES.OWNER, ROLES.ADMIN],
  'company.billing': [ROLES.OWNER, ROLES.ADMIN],
  'employees.manage': [ROLES.OWNER, ROLES.ADMIN],
  'workcenters.manage': [ROLES.OWNER, ROLES.ADMIN],
  'leaves.approve': [ROLES.OWNER, ROLES.ADMIN, ROLES.MANAGER],
  'leaves.request': [ROLES.OWNER, ROLES.ADMIN, ROLES.MANAGER, ROLES.EMPLOYEE],
  'reports.view': [ROLES.OWNER, ROLES.ADMIN, ROLES.MANAGER],
  'audit.view': [ROLES.OWNER, ROLES.ADMIN],
};

function roleOf(user) {
  if (!user) return null;
  // The legacy `admin` boolean is authoritative for company administrators.
  if (user.admin) return ROLES.ADMIN;
  return user.role || ROLES.EMPLOYEE;
}

function can(user, permission) {
  const allowed = PERMISSIONS[permission];
  if (!allowed) return false;
  return allowed.includes(roleOf(user));
}

// Express middleware factory guarding a route by permission.
function requirePermission(permission) {
  return function (req, res, next) {
    if (!req.user) return res.redirect_with_session(303, '/');
    if (!can(req.user, permission)) return res.redirect_with_session(303, '/');
    return next();
  };
}

// JSON-API variant: returns 401/403 instead of an HTML redirect.
function requirePermissionApi(permission) {
  return function (req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
    if (!can(req.user, permission)) return res.status(403).json({ error: 'forbidden' });
    return next();
  };
}

module.exports = { ROLES, PERMISSIONS, roleOf, can, requirePermission, requirePermissionApi };
