'use strict';

/*
 * Work-time incidents — block 4.
 *
 *   Employee (own incidents)
 *     GET  /time/incidents/                 the list (filter: all / open / in review / closed)
 *     GET  /time/incidents/new/             the form
 *     POST /time/incidents/                 file an incident
 *     GET  /time/incidents/:id/             the detail plus the activity thread
 *     POST /time/incidents/:id/comments/    add a clarification
 *     POST /time/incidents/:id/link/        attach one of my correction requests
 *
 *   Supervisor / owner-admin (the queue)
 *     GET  /time/incidents/queue/           incidents of my scope
 *     POST /time/incidents/:id/review/      take it into review
 *     POST /time/incidents/:id/resolve/     resolve it with an answer
 *     POST /time/incidents/:id/dismiss/     dismiss it with a reason
 *
 * Security:
 *   - every route is tenant scoped (ensureTenant) and permission checked;
 *   - the employee NEVER names another employee: the optional work session is
 *     looked up with companyId + userId = the acting user, so a tampered id is
 *     simply not found;
 *   - who may READ and who may DECIDE is decided in the service, not here, and
 *     is re-checked inside the transaction that locks the incident;
 *   - every mutation is a POST with the CSRF token from the global middleware;
 *   - the templates escape every user value (no triple-stash anywhere).
 */

const crypto = require('crypto');
const express = require('express');

const { ensureTenant } = require('../auth/tenant');
const { requirePermission } = require('../auth/permissions');
const schedule = require('../modules/time/schedule');
const clock = require('../modules/time/clock');
const corrections = require('../modules/time/corrections');
const incidents = require('../modules/time/incidents');

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

/** The normalised filter of the list (never free text). */
function readFilter(raw) {
  const value = String(raw || '');
  return incidents.FILTERS.some((f) => f.value === value) ? value : '';
}

/** Sessions of the employee, for the "related work session" chooser. */
async function loadSessions({ ctx, user }) {
  const entries = await ctx.db.TimeEntry.findAll({
    where: { companyId: ctx.company.id, userId: user.id },
    order: [['started_at', 'DESC'], ['id', 'DESC']],
    limit: 40,
  });

  return entries.map((entry) => ({
    id: entry.id,
    date: schedule.formatDateInZone(entry.startedAt, ctx.timezone),
    started_at: schedule.formatTimeInZone(entry.startedAt, ctx.timezone),
    ended_at: entry.endedAt ? schedule.formatTimeInZone(entry.endedAt, ctx.timezone) : null,
    is_open: entry.status === 'open',
    modality_label: clock.modalityLabel(entry.modality),
  }));
}

/** One session, presented the same way as in the detail page. */
function presentSession(entry, timezone) {
  if (!entry) return null;
  return {
    date: schedule.formatDateInZone(entry.startedAt, timezone),
    started_at: schedule.formatTimeInZone(entry.startedAt, timezone),
    ended_at: entry.endedAt ? schedule.formatTimeInZone(entry.endedAt, timezone) : null,
    is_open: entry.status === 'open',
    modality_label: clock.modalityLabel(entry.modality),
  };
}

/** The correction linked to an incident, presented for the detail page. */
function presentCorrectionLink(correction, timezone) {
  if (!correction) return null;
  return {
    id: correction.id,
    label: incidents.correctionLabel(correction, timezone),
    status: correction.status,
    status_label: corrections.STATUS_LABELS[correction.status] || correction.status,
  };
}

/** Names of a set of users, by id. */
async function namesById({ db, ids }) {
  const unique = Array.from(new Set(ids.filter((id) => !!id).map((id) => String(id))));
  if (!unique.length) return {};
  const users = await db.User.findAll({ where: { id: unique } });
  const map = {};
  users.forEach((u) => { map[u.id] = u.full_name(); });
  return map;
}

/**
 * Everything the detail page needs. Shared by the detail route and by the
 * redirects after an action, so both always render the same thing.
 */
async function buildDetail({ ctx, req, incident }) {
  const db = ctx.db;
  const entries = await incidents.listEntries({
    models: db, companyId: incident.companyId, incidentId: incident.id,
  });

  const [employee, resolver, entry, correction, linkable] = await Promise.all([
    db.User.findByPk(incident.userId),
    incident.resolvedById ? db.User.findByPk(incident.resolvedById) : Promise.resolve(null),
    incident.timeEntryId ? db.TimeEntry.findByPk(incident.timeEntryId) : Promise.resolve(null),
    incident.timeCorrectionId
      ? db.TimeCorrection.findByPk(incident.timeCorrectionId)
      : Promise.resolve(null),
    (String(incident.userId) === String(req.user.id) && !incidents.isFinal(incident.status))
      ? incidents.linkableCorrections({ models: db, user: req.user })
      : Promise.resolve([]),
  ]);

  const authorNames = await namesById({ db, ids: entries.map((e) => e.authorId) });

  const canManage = await incidents.canManage({
    models: db, actor: req.user, incident,
  });

  return {
    active_nav: 'time',
    timezone: ctx.timezone,
    timezone_source_label: ctx.timezone_source_label,
    incident: incidents.presentIncident(incident, {
      timezone: ctx.timezone,
      employeeName: employee ? employee.full_name() : null,
      resolverName: resolver ? resolver.full_name() : null,
      canManage,
      isOwn: String(incident.userId) === String(req.user.id),
      timeEntry: presentSession(entry, ctx.timezone),
      correction: presentCorrectionLink(correction, ctx.timezone),
    }),
    entries: entries.map((e) => incidents.presentEntry(e, {
      timezone: ctx.timezone,
      authorName: authorNames[e.authorId] || null,
      isManagerNote: e.kind !== incidents.ENTRY_KIND.COMMENT,
    })),
    linkable_corrections: linkable.map((c) => ({
      id: c.id,
      label: incidents.correctionLabel(c, ctx.timezone),
    })),
    message_limit: incidents.LIMITS.MESSAGE,
  };
}

// ---------------------------------------------------------------------------
// Employee: own incidents
// ---------------------------------------------------------------------------

router.get('/incidents/', requirePermission('time.incidents.request'), asyncHandler(async (req, res) => {
  const ctx = await buildContext(req);
  const filter = readFilter(req.query.status);
  const rows = await incidents.listForUser({
    models: ctx.db, user: req.user, filter,
  });

  // The counter is a COUNT over the authorised scope (never the length of a
  // page) and the entry to the tray depends on having a scope at all, so a
  // backlog of closed cases can hide neither a pending one nor the link.
  const pending = await incidents.countPending({ models: ctx.db, actor: req.user });
  const hasQueueScope = await incidents.hasQueueScope({ models: ctx.db, actor: req.user });

  res.render('time/incidents', {
    active_nav: 'time',
    timezone: ctx.timezone,
    timezone_source_label: ctx.timezone_source_label,
    incidents: rows.map((row) => incidents.presentIncident(row, { timezone: ctx.timezone })),
    filters: incidents.FILTERS,
    current_filter: filter,
    has_any: rows.length > 0,
    queue_pending: pending,
    can_see_queue: hasQueueScope,
  });
}));

router.get('/incidents/new/', requirePermission('time.incidents.request'), asyncHandler(async (req, res) => {
  const ctx = await buildContext(req);
  const sessions = await loadSessions({ ctx, user: req.user });

  res.render('time/incident_new', {
    active_nav: 'time',
    timezone: ctx.timezone,
    timezone_source_label: ctx.timezone_source_label,
    types: incidents.TYPES,
    sessions,
    defaults: {
      date: schedule.formatDateInZone(new Date(), ctx.timezone),
      type: incidents.TYPES[0].value,
      time_entry_id: parseEntryParam(req.query.session),
    },
    // One token per rendered form: a double submission cannot create two
    // incidents (the service returns the one that already exists).
    form_token: crypto.randomBytes(16).toString('hex'),
    limits: incidents.LIMITS,
  });
}));

function parseEntryParam(raw) {
  const id = parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

router.post('/incidents/', requirePermission('time.incidents.request'), asyncHandler(async (req, res) => {
  const ctx = await buildContext(req);
  const body = req.body || {};

  try {
    const result = await incidents.createIncident({
      models: ctx.db,
      actor: req.user,
      input: body,
      timezone: ctx.timezone,
    });

    if (result.created) {
      req.session.flash_message('Incident filed. You can follow its status here; your clock record has not been changed.');
    } else {
      req.session.flash_message('This incident had already been filed.');
    }
    return res.redirect_with_session('/time/incidents/' + result.incident.id + '/');
  } catch (err) {
    if (err && err.code) {
      req.session.flash_error(err.message);
    } else {
      console.error('Failed to file an incident for user ' + req.user.id + ': ' + err);
      req.session.flash_error('Failed to file the incident. Please try again.');
    }
    return res.redirect_with_session('/time/incidents/new/');
  }
}));

router.get('/incidents/queue/', requirePermission('time.incidents.request'), asyncHandler(async (req, res) => {
  const ctx = await buildContext(req);
  const filter = readFilter(req.query.status);
  const rows = await incidents.listQueue({
    models: ctx.db, actor: req.user, filter,
  });

  const names = await namesById({ db: ctx.db, ids: rows.map((r) => r.userId) });

  res.render('time/incident_queue', {
    active_nav: 'time',
    timezone: ctx.timezone,
    timezone_source_label: ctx.timezone_source_label,
    incidents: rows.map((row) => incidents.presentIncident(row, {
      timezone: ctx.timezone,
      employeeName: names[row.userId] || null,
    })),
    filters: incidents.FILTERS,
    current_filter: filter,
    is_administrator: incidents.isAdministrator(req.user),
  });
}));

router.get('/incidents/:id/', requirePermission('time.incidents.request'), asyncHandler(async (req, res) => {
  const ctx = await buildContext(req);

  let incident;
  try {
    incident = await incidents.getForActor({
      models: ctx.db, actor: req.user, incidentId: req.params.id,
    });
  } catch (err) {
    if (err && err.code === 'INCIDENT_NOT_FOUND') {
      req.session.flash_error('Unknown incident.');
      return res.redirect_with_session('/time/incidents/');
    }
    throw err;
  }

  const view = await buildDetail({ ctx, req, incident });
  res.render('time/incident_detail', view);
}));

router.post('/incidents/:id/comments/', requirePermission('time.incidents.request'), asyncHandler(async (req, res) => {
  const ctx = await buildContext(req);
  try {
    await incidents.addComment({
      models: ctx.db,
      actor: req.user,
      incidentId: req.params.id,
      body: (req.body && (req.body.body || req.body.comment)) || '',
    });
    req.session.flash_message('Message added.');
  } catch (err) {
    if (err && err.code) req.session.flash_error(err.message);
    else {
      console.error('Failed to add a message to an incident: ' + err);
      req.session.flash_error('Failed to add the message.');
    }
  }
  return res.redirect_with_session('/time/incidents/' + req.params.id + '/');
}));

router.post('/incidents/:id/link/', requirePermission('time.incidents.request'), asyncHandler(async (req, res) => {
  const ctx = await buildContext(req);
  try {
    await incidents.linkCorrection({
      models: ctx.db,
      actor: req.user,
      incidentId: req.params.id,
      correctionId: (req.body && req.body.correction_id) || '',
    });
    req.session.flash_message('The correction request was linked. It still follows its own approval flow.');
  } catch (err) {
    if (err && err.code) req.session.flash_error(err.message);
    else {
      console.error('Failed to link a correction to an incident: ' + err);
      req.session.flash_error('Failed to link the correction.');
    }
  }
  return res.redirect_with_session('/time/incidents/' + req.params.id + '/');
}));

// ---------------------------------------------------------------------------
// Supervisor / owner-admin: the decisions
// ---------------------------------------------------------------------------

router.post('/incidents/:id/review/', requirePermission('time.incidents.request'), asyncHandler(async (req, res) => {
  const ctx = await buildContext(req);
  try {
    await incidents.startReview({
      models: ctx.db, actor: req.user, incidentId: req.params.id,
    });
    req.session.flash_message('The incident is now in review.');
  } catch (err) {
    if (err && err.code) req.session.flash_error(err.message);
    else {
      console.error('Failed to take an incident into review: ' + err);
      req.session.flash_error('Failed to update the incident.');
    }
  }
  return res.redirect_with_session('/time/incidents/' + req.params.id + '/');
}));

router.post('/incidents/:id/resolve/', requirePermission('time.incidents.request'), asyncHandler(async (req, res) => {
  const ctx = await buildContext(req);
  try {
    const incident = await incidents.resolveIncident({
      models: ctx.db,
      actor: req.user,
      incidentId: req.params.id,
      response: (req.body && req.body.resolution) || '',
    });
    if (incident.selfResolved) {
      req.session.flash_message('Your own incident was resolved under the administrative exception. The self-resolution is recorded in the audit trail.');
    } else {
      req.session.flash_message('The incident was resolved and the answer is visible to the employee.');
    }
  } catch (err) {
    if (err && err.code) req.session.flash_error(err.message);
    else {
      console.error('Failed to resolve an incident: ' + err);
      req.session.flash_error('Failed to resolve the incident.');
    }
  }
  return res.redirect_with_session('/time/incidents/' + req.params.id + '/');
}));

router.post('/incidents/:id/dismiss/', requirePermission('time.incidents.request'), asyncHandler(async (req, res) => {
  const ctx = await buildContext(req);
  try {
    const incident = await incidents.dismissIncident({
      models: ctx.db,
      actor: req.user,
      incidentId: req.params.id,
      reason: (req.body && req.body.resolution) || '',
    });
    if (incident.selfResolved) {
      req.session.flash_message('Your own incident was dismissed under the administrative exception. The self-resolution is recorded in the audit trail.');
    } else {
      req.session.flash_message('The incident was dismissed with its reason.');
    }
  } catch (err) {
    if (err && err.code) req.session.flash_error(err.message);
    else {
      console.error('Failed to dismiss an incident: ' + err);
      req.session.flash_error('Failed to dismiss the incident.');
    }
  }
  return res.redirect_with_session('/time/incidents/' + req.params.id + '/');
}));

module.exports = router;