'use strict';

/*
 * Break policy settings — block 2.
 *
 *   GET  /settings/breaks/   three break types, each with "counts as worked time"
 *   POST /settings/breaks/   save the policy
 *
 * Company-level only (no per-employee overrides in this block). Reuses the existing
 * company.settings permission (owner/admin) and tenant guard: no new permission
 * system is introduced.
 *
 * Saving the policy never rewrites history: each break stores the policy that was
 * in force when it started (see time_breaks.counts_as_work).
 *
 * Async handlers are wrapped so a rejection reaches the error middleware instead of
 * terminating the process (Express 4 does not catch rejected promises).
 */

const express = require('express');

const { ensureTenant } = require('../auth/tenant');
const { requirePermission } = require('../auth/permissions');
const breaks = require('../modules/time/breaks');

const router = express.Router();

function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

router.use(ensureTenant);
router.use(requirePermission('company.settings'));

function renderPage(req, res, extra) {
  return req.user.getCompany().then((company) => breaks.getPolicy(req.app.get('db_model'), company.id)
    .then((policy) => {
      res.render('break_policy_settings', Object.assign({
        active_nav: 'settings',
        policy,
        // Resolve the checked state here: nested Handlebars context lookups inside
        // the loop were reading the wrong scope, so saved policies rendered as if
        // they were disabled.
        break_types: breaks.BREAK_TYPES.map((t) => ({
          value: t.value,
          label: t.label,
          counts: policy[t.value] === true,
        })),
      }, extra || {}));
    }));
}

router.get('/breaks/', asyncHandler(async (req, res) => {
  await renderPage(req, res);
}));

router.post('/breaks/', asyncHandler(async (req, res) => {
  const company = await req.user.getCompany();
  const body = req.body || {};

  // Checkboxes are absent when unchecked, so read them explicitly.
  const incoming = {};
  breaks.BREAK_TYPE_VALUES.forEach((type) => {
    incoming[type] = body['counts_' + type] === '1' || body['counts_' + type] === 'on';
  });

  try {
    await breaks.setPolicy(req.app.get('db_model'), company.id, incoming);
    req.session.flash_message('Break policy saved. It applies to breaks started from now on; ' +
      'already recorded breaks keep the criterion they had.');
  } catch (err) {
    console.error('Failed to save break policy for company ' + company.id + ': ' + err);
    req.session.flash_error('Failed to save the break policy.');
  }

  return res.redirect_with_session('/settings/breaks/');
}));

module.exports = router;