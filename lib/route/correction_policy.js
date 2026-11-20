'use strict';

/*
 * Company correction policy — block 3.
 *
 *   GET  /settings/corrections/   how corrections are resolved in this company
 *   POST /settings/corrections/   save the policy
 *
 * Two modes:
 *   self_service      -> the employee's correction is applied immediately.
 *   approval_required -> a supervisor approves it first. This is the initial
 *                        default for a company that never configured anything.
 *
 * The policy is snapshotted onto every request, so saving a new policy does NOT
 * approve pending requests, does NOT revert applied corrections and does NOT
 * touch the history. It only decides how FUTURE requests are handled.
 *
 * Only owner/admin may read or write it (the existing company.settings
 * permission), and the tenant guard keeps every company separate.
 */

const express = require('express');

const { ensureTenant } = require('../auth/tenant');
const { requirePermission } = require('../auth/permissions');
const corrections = require('../modules/time/corrections');

const router = express.Router();

function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

router.use(ensureTenant);
router.use(requirePermission('company.settings'));

router.get('/corrections/', asyncHandler(async (req, res) => {
  const db = req.app.get('db_model');
  const company = await req.user.getCompany();
  const mode = await corrections.getPolicy({ models: db, companyId: company.id });

  res.render('correction_policy_settings', {
    active_nav: 'settings',
    mode,
    modes: corrections.MODE_VALUES.map((value) => ({
      value,
      label: corrections.MODE_LABELS[value],
      is_current: value === mode,
    })),
  });
}));

router.post('/corrections/', asyncHandler(async (req, res) => {
  const db = req.app.get('db_model');
  const company = await req.user.getCompany();
  const mode = String((req.body && req.body.mode) || '');

  try {
    await corrections.setPolicy({ models: db, companyId: company.id, mode });
    req.session.flash_message('Correction policy saved. It applies to requests submitted from now on; ' +
      'pending and already applied requests keep the policy they were created with.');
  } catch (err) {
    if (err && err.code) req.session.flash_error(err.message);
    else {
      console.error('Failed to save the correction policy for company ' + company.id + ': ' + err);
      req.session.flash_error('Failed to save the correction policy.');
    }
  }

  return res.redirect_with_session('/settings/corrections/');
}));

module.exports = router;
