'use strict';

/*
 * Correction requests and supervisor approvals — block 3.
 *
 *   GET  /time/corrections/                  the employee's own requests
 *   GET  /time/corrections/new/              step 1: what has to be corrected
 *   GET  /time/corrections/new/:type/        step 2: which record (or the form)
 *   GET  /time/corrections/new/:type/:target/ step 3: the values + the reason
 *   POST /time/corrections/                  submit the request
 *   POST /time/corrections/:id/cancel/       withdraw a pending request
 *
 *   GET  /time/approvals/                    requests waiting for a supervisor
 *   POST /time/approvals/:id/approve/        approve (and apply)
 *   POST /time/approvals/:id/reject/         reject with a short explanation
 *
 * The form is split in steps on purpose: only the fields that belong to the
 * chosen correction type are shown, which keeps the screen small on a phone and
 * needs no JavaScript (the CSP only allows scripts with a nonce).
 *
 * Security:
 *   - every route is tenant scoped (ensureTenant) and permission checked;
 *   - the employee NEVER names another employee: the target session is looked
 *     up with companyId + userId = the acting user, so a tampered id is simply
 *     not found;
 *   - the authorisation to RESOLVE a request (supervisor of that employee, or
 *     owner/admin) is decided in the service, not here, and is re-checked
 *     inside the resolution transaction;
 *   - the requester may decide on their OWN request only as an administrative
 *     exception (owner/admin, under the 'approval_required' policy). The screen
 *     asks the service for the same right, so it never offers an action that
 *     would end up being refused;
 *   - every mutation is a POST with the CSRF token from the global middleware.
 */

const express = require('express');

const { ensureTenant } = require('../auth/tenant');
const { requirePermission } = require('../auth/permissions');
const schedule = require('../modules/time/schedule');
const clock = require('../modules/time/clock');
const breaks = require('../modules/time/breaks');
const corrections = require('../modules/time/corrections');

const router = express.Router();

function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

router.use(ensureTenant);

/** Company, work centre and the effective timezone of the acting user. */
function buildContext(req) {
  const db = req.app.get('db_model');
  return req.user.getCompany().then((company) => {
    const workCenterPromise = req.user.workCenterId
      ? db.WorkCenter.findByPk(req.user.workCenterId)
      : Promise.resolve(null);
    return workCenterPromise.then((workCenter) => {
      const info = schedule.resolveTimezoneInfo({ company, workCenter });
      return {
        db,
        company,
        workCenter,
        timezone: info.timezone,
        timezone_source_label: schedule.TIMEZONE_LABELS[info.source],
      };
    });
  });
}

function localDateTime(value, timezone) {
  return schedule.formatDateInZone(value, timezone) + ' ' + schedule.formatTimeInZone(value, timezone);
}

/** Sessions of the employee, with their breaks, for the target chooser. */
async function loadTargets({ ctx, user }) {
  const entries = await ctx.db.TimeEntry.findAll({
    where: { companyId: ctx.company.id, userId: user.id },
    order: [['started_at', 'DESC'], ['id', 'DESC']],
    limit: 40,
  });

  const breakMap = await breaks.breaksByEntryIds({
    models: ctx.db, companyId: ctx.company.id, entryIds: entries.map((e) => e.id),
  });

  const sessions = entries.map((entry) => ({
    id: entry.id,
    date: schedule.formatDateInZone(entry.startedAt, ctx.timezone),
    started_at: schedule.formatTimeInZone(entry.startedAt, ctx.timezone),
    ended_at: entry.endedAt ? schedule.formatTimeInZone(entry.endedAt, ctx.timezone) : null,
    is_open: entry.status === 'open',
    modality: entry.modality,
    modality_label: clock.modalityLabel(entry.modality),
    source: entry.source,
    is_declared: entry.source === 'declared',
    breaks: (breakMap[entry.id] || []).map((b) => ({
      id: b.id,
      type: b.type,
      type_label: breaks.labelOf(b.type),
      counts_as_work: b.countsAsWork === true,
      date: schedule.formatDateInZone(b.startedAt, ctx.timezone),
      started_at: schedule.formatTimeInZone(b.startedAt, ctx.timezone),
      ended_at: b.endedAt ? schedule.formatTimeInZone(b.endedAt, ctx.timezone) : null,
      is_open: !b.endedAt,
    })),
  }));

  return sessions;
}

function parseTarget(raw) {
  const match = /^(entry|break)-(\d+)$/.exec(String(raw || ''));
  if (!match) return null;
  return { kind: match[1], id: parseInt(match[2], 10) };
}

// ---------------------------------------------------------------------------
// Employee: own requests
// ---------------------------------------------------------------------------

router.get('/corrections/', requirePermission('time.corrections.request'), asyncHandler(async (req, res) => {
  const ctx = await buildContext(req);
  const rows = await corrections.listForUser({ models: ctx.db, user: req.user, limit: 50 });

  const policy = await corrections.getPolicy({ models: ctx.db, companyId: ctx.company.id });

  res.render('time/corrections', {
    active_nav: 'time',
    timezone: ctx.timezone,
    timezone_source_label: ctx.timezone_source_label,
    policy,
    policy_label: corrections.MODE_LABELS[policy],
    corrections: rows.map((c) => corrections.presentCorrection(c, { timezone: ctx.timezone })),
  });
}));

router.get('/corrections/new/', requirePermission('time.corrections.request'), asyncHandler(async (req, res) => {
  const ctx = await buildContext(req);
  const policy = await corrections.getPolicy({ models: ctx.db, companyId: ctx.company.id });

  res.render('time/correction_type', {
    active_nav: 'time',
    timezone: ctx.timezone,
    policy,
    policy_label: corrections.MODE_LABELS[policy],
    types: corrections.TYPES,
  });
}));

/**
 * Step 2 (choose the record) or the form itself, when there is nothing to
 * choose (a forgotten session has no session yet).
 */
router.get('/corrections/new/:type/', requirePermission('time.corrections.request'), asyncHandler(async (req, res) => {
  const ctx = await buildContext(req);
  const type = String(req.params.type || '');

  if (!corrections.TYPE_VALUES.includes(type)) {
    req.session.flash_error('Unknown correction type.');
    return res.redirect_with_session('/time/corrections/new/');
  }

  const policy = await corrections.getPolicy({ models: ctx.db, companyId: ctx.company.id });

  if (type === 'missing_entry') {
    return res.render('time/correction_form', {
      active_nav: 'time',
      timezone: ctx.timezone,
      policy,
      policy_label: corrections.MODE_LABELS[policy],
      type,
      type_label: corrections.labelOfType(type),
      target: null,
      sessions: [],
      break_list: [],
      defaults: { date: schedule.formatDateInZone(new Date(), ctx.timezone) },
      modalities: clock.MODALITIES,
      break_types: breaks.BREAK_TYPES,
    });
  }

  const sessions = await loadTargets({ ctx, user: req.user });

  res.render('time/correction_target', {
    active_nav: 'time',
    timezone: ctx.timezone,
    policy,
    policy_label: corrections.MODE_LABELS[policy],
    type,
    type_label: corrections.labelOfType(type),
    sessions,
  });
}));

/** Step 3: the values and the reason. */
router.get('/corrections/new/:type/:target/', requirePermission('time.corrections.request'), asyncHandler(async (req, res) => {
  const ctx = await buildContext(req);
  const type = String(req.params.type || '');
  const target = parseTarget(req.params.target);

  if (!corrections.TYPE_VALUES.includes(type) || !target) {
    req.session.flash_error('Unknown correction request.');
    return res.redirect_with_session('/time/corrections/new/');
  }

  const policy = await corrections.getPolicy({ models: ctx.db, companyId: ctx.company.id });
  const sessions = await loadTargets({ ctx, user: req.user });

  let session = null;
  let breakRow = null;

  if (target.kind === 'entry') {
    session = sessions.find((s) => s.id === target.id) || null;
    if (!session) {
      req.session.flash_error('Unknown work session.');
      return res.redirect_with_session('/time/corrections/new/' + encodeURIComponent(type) + '/');
    }
  } else {
    sessions.forEach((s) => {
      s.breaks.forEach((b) => { if (b.id === target.id) breakRow = b; });
    });
    if (!breakRow) {
      req.session.flash_error('Unknown break.');
      return res.redirect_with_session('/time/corrections/new/' + encodeURIComponent(type) + '/');
    }
  }

  const defaults = {};
  if (type === 'entry_start' && session) {
    defaults.date = session.date;
    defaults.time = session.started_at;
  } else if (type === 'entry_end') {
    defaults.date = session ? session.date : null;
    defaults.time = session && session.ended_at ? session.ended_at : null;
  } else if (type === 'break_start' && breakRow) {
    defaults.date = breakRow.date;
    defaults.time = breakRow.started_at;
  } else if (type === 'break_end' && breakRow) {
    defaults.date = breakRow.date;
    defaults.time = breakRow.ended_at;
  } else if (type === 'break_type' && breakRow) {
    defaults.break_type = breakRow.type;
  } else if (type === 'modality' && session) {
    defaults.modality = session.modality;
  } else if (type === 'break_missing' && session) {
    defaults.date = session.date;
  }

  res.render('time/correction_form', {
    active_nav: 'time',
    timezone: ctx.timezone,
    policy,
    policy_label: corrections.MODE_LABELS[policy],
    type,
    type_label: corrections.labelOfType(type),
    target: target.kind + '-' + target.id,
    sessions,
    break_list: breakRow ? [breakRow] : [],
    defaults,
    modalities: clock.MODALITIES,
    break_types: breaks.BREAK_TYPES,
  });
}));

router.post('/corrections/', requirePermission('time.corrections.request'), asyncHandler(async (req, res) => {
  const ctx = await buildContext(req);
  const body = req.body || {};
  const type = String(body.type || '');
  const target = parseTarget(body.target);

  try {
    const result = await corrections.createRequest({
      models: ctx.db,
      actor: req.user,
      type,
      entryId: target && target.kind === 'entry' ? target.id : null,
      breakId: target && target.kind === 'break' ? target.id : null,
      input: body,
      timezone: ctx.timezone,
    });

    if (result.applied) {
      req.session.flash_message('Correction applied. The original record is preserved in the session history.');
    } else if (result.correction.status === 'conflict') {
      req.session.flash_error('The correction could not be applied automatically: ' + (result.correction.conflictReason || 'the record changed meanwhile'));
    } else {
      req.session.flash_message('Correction request sent. It is waiting for your supervisor.');
    }
  } catch (err) {
    if (err && err.code) {
      req.session.flash_error(err.message);
    } else {
      console.error('Failed to create a correction request for user ' + req.user.id + ': ' + err);
      req.session.flash_error('Failed to send the correction request. Please try again.');
    }
  }

  return res.redirect_with_session('/time/corrections/');
}));

router.post('/corrections/:id/cancel/', requirePermission('time.corrections.request'), asyncHandler(async (req, res) => {
  const ctx = await buildContext(req);
  try {
    await corrections.cancelRequest({
      models: ctx.db, actor: req.user, correctionId: req.params.id,
    });
    req.session.flash_message('Correction request withdrawn.');
  } catch (err) {
    if (err && err.code) req.session.flash_error(err.message);
    else {
      console.error('Failed to cancel a correction request: ' + err);
      req.session.flash_error('Failed to withdraw the request.');
    }
  }
  return res.redirect_with_session('/time/corrections/');
}));

// ---------------------------------------------------------------------------
// Supervisor: requests waiting for a decision
// ---------------------------------------------------------------------------

router.get('/approvals/', requirePermission('time.corrections.request'), asyncHandler(async (req, res) => {
  const ctx = await buildContext(req);
  const rows = await corrections.listResolvable({ models: ctx.db, actor: req.user });

  const employeeIds = rows.map((r) => r.userId);
  const employees = employeeIds.length
    ? await ctx.db.User.findAll({ where: { id: employeeIds } })
    : [];
  const nameById = {};
  employees.forEach((u) => { nameById[u.id] = u.full_name(); });

  // The right to decide is computed for EVERY row, not only for the rows of the
  // other employees: an ordinary supervisor must not see the action on their
  // own request, while an owner/admin does see it on their own request
  // (the administrative self-approval). The SERVICE decides the same way, so
  // the screen can never offer an action that would be refused.
  const presented = [];
  for (const row of rows) {
    const canDecide = await corrections.canResolve({
      models: ctx.db, actor: req.user, correction: row,
    });
    presented.push(corrections.presentCorrection(row, {
      timezone: ctx.timezone,
      employeeName: nameById[row.userId] || null,
      canDecide,
      isOwn: String(row.userId) === String(req.user.id),
    }));
  }

  res.render('time/approvals', {
    active_nav: 'time',
    timezone: ctx.timezone,
    timezone_source_label: ctx.timezone_source_label,
    corrections: presented,
  });
}));

router.post('/approvals/:id/approve/', requirePermission('time.corrections.request'), asyncHandler(async (req, res) => {
  const ctx = await buildContext(req);
  try {
    const result = await corrections.resolveRequest({
      models: ctx.db,
      actor: req.user,
      correctionId: req.params.id,
      decision: 'approve',
    });

    if (result.status === 'conflict') {
      req.session.flash_error('The request was NOT applied: ' + result.conflict + ' It needs a new decision.');
    } else if (result.selfApproval) {
      req.session.flash_message('Your own request was approved under the administrative exception and applied. The original record is preserved and the self-approval is recorded in the audit trail.');
    } else {
      req.session.flash_message('Request approved and applied. The original record is preserved.');
    }
  } catch (err) {
    if (err && err.code) req.session.flash_error(err.message);
    else {
      console.error('Failed to approve a correction request: ' + err);
      req.session.flash_error('Failed to approve the request.');
    }
  }
  return res.redirect_with_session('/time/approvals/');
}));

router.post('/approvals/:id/reject/', requirePermission('time.corrections.request'), asyncHandler(async (req, res) => {
  const ctx = await buildContext(req);
  try {
    await corrections.resolveRequest({
      models: ctx.db,
      actor: req.user,
      correctionId: req.params.id,
      decision: 'reject',
      reason: (req.body && req.body.reason) || '',
    });
    req.session.flash_message('Request rejected.');
  } catch (err) {
    if (err && err.code) req.session.flash_error(err.message);
    else {
      console.error('Failed to reject a correction request: ' + err);
      req.session.flash_error('Failed to reject the request.');
    }
  }
  return res.redirect_with_session('/time/approvals/');
}));

module.exports = router;
