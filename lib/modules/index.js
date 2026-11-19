'use strict';

/*
 * Modular monolith module registry.
 *
 * The application is a single deployable (modular monolith) organized into
 * business modules. Active modules ship today; planned modules are declared so
 * the architecture, permissions and tenant guards are ready for them without
 * reworking the core. No microservices / React / TypeScript are introduced.
 *
 * Future modules mount their routes under /<module>/ and register permissions
 * in lib/auth/permissions.js, reusing lib/auth/tenant.js for isolation.
 */

const MODULES = [
  { id: 'core', name: 'Core: companies, users, departments, work centers, auth', status: 'active', mount: '/' },
  { id: 'absences', name: 'Absences & allowances: leaves, approvals, calendars, feeds', status: 'active', mount: '/calendar,/requests' },
  { id: 'time-tracking', name: 'Time tracking / clock-in (block 1: sessions + expected schedule)', status: 'active', mount: '/time' },
  { id: 'shifts', name: 'Shift planning', status: 'planned', mount: '/shifts' },
  { id: 'documents', name: 'Document management', status: 'planned', mount: '/documents' },
  { id: 'employee-portal', name: 'Employee self-service portal', status: 'planned', mount: '/portal' },
  { id: 'analytics', name: 'Reports & analytics', status: 'planned', mount: '/analytics' },
  { id: 'payroll', name: 'Payroll integrations', status: 'planned', mount: '/payroll' },
  { id: 'subscriptions', name: 'Plans & commercial subscriptions', status: 'planned', mount: '/billing' },
];

function listModules() {
  return MODULES.slice();
}

function getModule(id) {
  return MODULES.find((m) => m.id === id) || null;
}

function activeModules() {
  return MODULES.filter((m) => m.status === 'active');
}

module.exports = { MODULES, listModules, getModule, activeModules };
