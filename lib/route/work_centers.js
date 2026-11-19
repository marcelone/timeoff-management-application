'use strict';

/*
 * Work centre settings — minimal configuration needed by the time-tracking
 * module's timezone chain (block 1).
 *
 * Only what the timezone configuration needs:
 *   GET  /settings/workcenters/       list centres + add form
 *   POST /settings/workcenters/       create a centre
 *   POST /settings/workcenters/:id/   update name / timezone
 *
 * A centre's timezone is OPTIONAL: leaving it empty means "inherit from the
 * company" (WorkCenter.timezone stays NULL, which is also its existing default,
 * so no schema change is needed). Any provided value must be an IANA zone known
 * to moment-timezone; the same list the company settings already validate
 * against, so both levels accept exactly the same values.
 *
 * Changing a timezone never rewrites clock entries: entries store UTC instants
 * and the zone is only used when rendering them.
 *
 * Every route is tenant-scoped (ensureTenant) and guarded by the existing
 * workcenters.manage permission (owner/admin); all queries carry companyId and
 * a centre from another company is never found nor updated.
 */

const express = require('express');
const moment_tz = require('moment-timezone');

const { ensureTenant } = require('../auth/tenant');
const { requirePermission } = require('../auth/permissions');
const timeSchedule = require('../modules/time/schedule');

const router = express.Router();

function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

router.use(ensureTenant);
router.use(requirePermission('workcenters.manage'));

const INHERIT = '';

/** Normalise the submitted timezone: '' means inherit (NULL). */
function readTimezone(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === INHERIT || value === 'inherit') {
    return { ok: true, value: null };
  }
  if (!timeSchedule.isValidTimezone(value)) {
    return { ok: false, value: null };
  }
  return { ok: true, value };
}

function renderPage(req, res, extra) {
  const db = req.app.get('db_model');

  return req.user.getCompany()
    .then((company) => db.WorkCenter.findAll({
      where: { companyId: company.id },
      order: [['name', 'ASC']],
    }).then((centres) => {
      const zones = moment_tz.tz.names();
      res.render('workcenters_settings', Object.assign({
        active_nav: 'settings',
        company_timezone: company.timezone,
        timezones_available: zones,
        centres: centres.map((c) => ({
          id: c.id,
          name: c.name,
          address: c.address,
          timezone: c.timezone || INHERIT,
          effective: timeSchedule.resolveTimezoneInfo({ workCenter: c, company }).timezone,
          source_label: timeSchedule.TIMEZONE_LABELS[
            timeSchedule.resolveTimezoneInfo({ workCenter: c, company }).source
          ],
        })),
      }, extra || {}));
    }));
}

router.get('/workcenters/', asyncHandler(async (req, res) => {
  await renderPage(req, res);
}));

router.post('/workcenters/', asyncHandler(async (req, res) => {
  const db = req.app.get('db_model');
  const company = await req.user.getCompany();

  const name = String((req.body && req.body.name) || '').trim();
  const address = String((req.body && req.body.address) || '').trim();
  const tz = readTimezone(req.body && req.body.timezone);

  if (!name) {
    req.session.flash_error('The work centre needs a name.');
    return res.redirect_with_session('/settings/workcenters/');
  }
  if (!tz.ok) {
    req.session.flash_error('Unknown time zone. Pick one from the list or leave it to inherit from the company.');
    return res.redirect_with_session('/settings/workcenters/');
  }

  await db.WorkCenter.create({
    companyId: company.id,
    name,
    address: address || null,
    timezone: tz.value, // NULL = inherit from the company
  });

  req.session.flash_message('Work centre created.');
  return res.redirect_with_session('/settings/workcenters/');
}));

router.post('/workcenters/:centre_id/', asyncHandler(async (req, res) => {
  const db = req.app.get('db_model');
  const company = await req.user.getCompany();

  const centreId = parseInt(req.params.centre_id, 10);
  if (!Number.isInteger(centreId)) {
    req.session.flash_error('Unknown work centre.');
    return res.redirect_with_session('/settings/workcenters/');
  }

  // Tenant guard: the centre must belong to the acting company.
  const centre = await db.WorkCenter.findOne({ where: { id: centreId, companyId: company.id } });
  if (!centre) {
    req.session.flash_error('Unknown work centre.');
    return res.redirect_with_session('/settings/workcenters/');
  }

  const name = String((req.body && req.body.name) || '').trim();
  const address = String((req.body && req.body.address) || '').trim();
  const tz = readTimezone(req.body && req.body.timezone);

  if (!name) {
    req.session.flash_error('The work centre needs a name.');
    return res.redirect_with_session('/settings/workcenters/');
  }
  if (!tz.ok) {
    req.session.flash_error('Unknown time zone. Pick one from the list or leave it to inherit from the company.');
    return res.redirect_with_session('/settings/workcenters/');
  }

  centre.name = name;
  centre.address = address || null;
  centre.timezone = tz.value;
  await centre.save();

  req.session.flash_message(tz.value
    ? 'Work centre saved with its own time zone.'
    : 'Work centre saved: it inherits the company time zone.');
  return res.redirect_with_session('/settings/workcenters/');
}));

module.exports = router;