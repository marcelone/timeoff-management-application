'use strict';

/*
 * Time tracking routes — block 1.
 *
 *   GET  /time/                    employee screen: expected schedule, open session, history
 *   POST /time/start               clock in  (modality in the body)
 *   POST /time/stop                clock out
 *   GET  /time/schedule/           admin: expected-week configuration
 *   POST /time/schedule/           admin: save expected week for one scope
 *   POST /time/schedule/template/  admin: apply an explicit office template
 *
 * Security:
 *   - every route requires an authenticated, tenant-scoped user (ensureTenant)
 *     and the RBAC permission for the action;
 *   - the acting user is always req.user: no route accepts a target user id, so a
 *     request cannot clock in/out on behalf of somebody else;
 *   - every query/mutation is filtered by companyId, never trusting the body;
 *   - these routes only accept urlencoded form bodies, so the global CSRF
 *     middleware validates the token before the handler runs. Multipart is only
 *     allowed on the CSV import route (see lib/middleware/csrf.js).
 *
 * Express 4 does not catch rejected promises from async handlers: an unhandled
 * rejection would terminate the Node process (taking every company down). All
 * handlers below are wrapped in asyncHandler(), which forwards the rejection to
 * the error middleware.
 */

const express = require('express');
const moment = require('moment-timezone');

const { ensureTenant } = require('../auth/tenant');
const { requirePermission, can } = require('../auth/permissions');
const schedule = require('../modules/time/schedule');
const clock = require('../modules/time/clock');

const router = express.Router();

// Wrap an async handler so a rejected promise reaches next(err) instead of
// becoming an unhandled rejection that kills the process.
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

router.use(ensureTenant);

const SOURCE_LABELS = {
  user: 'own schedule',
  department: 'department schedule',
  company: 'company schedule',
};

function buildContext(req) {
  const db = req.app.get('db_model');
  return req.user.getCompany()
    .then((company) => {
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
          timezone_source: info.source,
          timezone_source_label: schedule.TIMEZONE_LABELS[info.source],
        };
      });
    });
}

/** Shape an entry into the strings the template renders (already in local tz). */
function presentEntry(entry, timezone) {
  const elapsed = schedule.elapsedMinutes(entry.startedAt, entry.endedAt);
  return {
    id: entry.id,
    modality: entry.modality,
    modality_label: clock.modalityLabel(entry.modality),
    status: entry.status,
    is_open: entry.status === 'open',
    date: schedule.formatDateInZone(entry.startedAt, timezone),
    started_at: schedule.formatTimeInZone(entry.startedAt, timezone),
    ended_at: entry.endedAt ? schedule.formatTimeInZone(entry.endedAt, timezone) : null,
    elapsed_minutes: elapsed,
    elapsed_label: schedule.humanDuration(elapsed),
  };
}

function presentSchedule(resolved) {
  if (!resolved) return null;
  return {
    working: resolved.working,
    start: resolved.startTime,
    end: resolved.endTime,
    source_label: SOURCE_LABELS[resolved.source] || resolved.source,
  };
}

router.get('/', requirePermission('time.clock'), asyncHandler(async (req, res) => {
  const ctx = await buildContext(req);
  const now = clock.nowUtc();

  const [openEntry, todaySchedule, recent] = await Promise.all([
    clock.findOpenEntry({ models: ctx.db, user: req.user }),
    // The weekday must be resolved in the effective timezone, not in UTC.
    schedule.resolveScheduleForUser({
      models: ctx.db, user: req.user, date: now, timezone: ctx.timezone,
    }),
    clock.listRecentEntries({ models: ctx.db, user: req.user, limit: 10 }),
  ]);

  res.render('time/index', {
    active_nav: 'time',
    timezone: ctx.timezone,
    timezone_source_label: ctx.timezone_source_label,
    today_schedule: presentSchedule(todaySchedule),
    open_entry: openEntry ? presentEntry(openEntry, ctx.timezone) : null,
    entries: recent.map((e) => presentEntry(e, ctx.timezone)),
    modalities: clock.MODALITIES,
    last_closed: (!openEntry && recent.length && recent[0].status === 'closed')
      ? presentEntry(recent[0], ctx.timezone)
      : null,
    can_manage_schedules: can(req.user, 'time.schedules.manage'),
  });
}));

router.post('/start', requirePermission('time.clock'), asyncHandler(async (req, res) => {
  const modality = (req.body && req.body.modality) || '';
  const ctx = await buildContext(req);

  try {
    await clock.startEntry({ models: ctx.db, user: req.user, modality });
    req.session.flash_message('Work session started at ' +
      schedule.formatTimeInZone(clock.nowUtc(), ctx.timezone) + ' (' + ctx.timezone + ').');
  } catch (err) {
    if (err.code === 'ALREADY_OPEN') {
      req.session.flash_error('You already have an open work session. Finish it before starting a new one.');
    } else if (err.code === 'INVALID_MODALITY') {
      req.session.flash_error('Please choose a valid work modality (office, remote or travel).');
    } else {
      console.error('Failed to start work session for user ' + req.user.id + ': ' + err);
      req.session.flash_error('Failed to start the work session. Please try again.');
    }
  }

  return res.redirect_with_session('/time/');
}));

router.post('/stop', requirePermission('time.clock'), asyncHandler(async (req, res) => {
  const ctx = await buildContext(req);

  try {
    const entry = await clock.stopEntry({ models: ctx.db, user: req.user });
    req.session.flash_message('Work session finished at ' +
      schedule.formatTimeInZone(entry.endedAt, ctx.timezone) +
      ' — elapsed ' + schedule.humanDuration(schedule.elapsedMinutes(entry.startedAt, entry.endedAt)) + '.');
  } catch (err) {
    if (err.code === 'NOT_OPEN') {
      req.session.flash_error('There is no open work session to finish.');
    } else if (err.code === 'INVALID_END') {
      req.session.flash_error('The end time cannot be before the start time.');
    } else {
      console.error('Failed to stop work session for user ' + req.user.id + ': ' + err);
      req.session.flash_error('Failed to finish the work session. Please try again.');
    }
  }

  return res.redirect_with_session('/time/');
}));

// ---------------------------------------------------------------------------
// Admin: expected schedule configuration
// ---------------------------------------------------------------------------

function parseScope(raw, ctx) {
  if (typeof raw !== 'string' || !raw.length) {
    return { scopeType: 'company', scopeId: ctx.company.id };
  }
  const [kind, idRaw] = raw.split(':');
  if (kind === 'company') return { scopeType: 'company', scopeId: ctx.company.id };
  const id = parseInt(idRaw, 10);
  if (!Number.isInteger(id)) return null;
  if (kind === 'department') return { scopeType: 'department', scopeId: id };
  if (kind === 'user') return { scopeType: 'user', scopeId: id };
  return null;
}

/** Ensure a department/user scope actually belongs to the acting company. */
async function scopeBelongsToCompany(ctx, scope) {
  if (scope.scopeType === 'company') return scope.scopeId === ctx.company.id;
  if (scope.scopeType === 'department') {
    const dep = await ctx.db.Department.findOne({ where: { id: scope.scopeId, companyId: ctx.company.id } });
    return !!dep;
  }
  if (scope.scopeType === 'user') {
    const user = await ctx.db.User.findOne({ where: { id: scope.scopeId, companyId: ctx.company.id } });
    return !!user;
  }
  return false;
}

async function loadScopeOptions(ctx) {
  const [departments, users] = await Promise.all([
    ctx.db.Department.findAll({ where: { companyId: ctx.company.id }, order: [['name', 'ASC']] }),
    ctx.db.User.findAll({ where: { companyId: ctx.company.id }, order: [['lastname', 'ASC'], ['name', 'ASC']] }),
  ]);
  return {
    departments: departments.map((d) => ({ scope: 'department:' + d.id, label: 'Department: ' + d.name })),
    users: users.map((u) => ({ scope: 'user:' + u.id, label: 'Employee: ' + u.full_name() })),
  };
}

/**
 * Wider scopes than the selected one, narrowest first. Used to show what an
 * "inherit" day would resolve to, so the admin sees the effective value while
 * still being able to say "explicitly not working".
 */
async function widerScopes(ctx, scope) {
  const out = [];
  if (scope.scopeType === 'user') {
    const user = await ctx.db.User.findOne({ where: { id: scope.scopeId, companyId: ctx.company.id } });
    if (user && user.DepartmentId) out.push({ scopeType: 'department', scopeId: user.DepartmentId });
  }
  if (scope.scopeType !== 'company') out.push({ scopeType: 'company', scopeId: ctx.company.id });
  return out;
}

async function inheritHint(ctx, scope) {
  const wider = await widerScopes(ctx, scope);
  if (!wider.length) return {};
  const rows = await ctx.db.WorkScheduleDay.findAll({
    where: {
      companyId: ctx.company.id,
      [ctx.db.Sequelize.Op.or]: wider.map((s) => ({ scopeType: s.scopeType, scopeId: s.scopeId })),
    },
  });
  const byDay = {};
  rows.forEach((r) => {
    const current = byDay[r.weekday];
    const priority = schedule.SCOPE_PRIORITY;
    if (!current || (priority[r.scopeType] || 0) > (priority[current.scopeType] || 0)) {
      byDay[r.weekday] = r;
    }
  });
  const hint = {};
  Object.keys(byDay).forEach((wd) => {
    const row = byDay[wd];
    hint[wd] = row.isWorkingDay === false
      ? 'non-working (inherited)'
      : row.startTime + '–' + row.endTime + ' (inherited)';
  });
  return hint;
}

async function loadWeek(ctx, scope) {
  const [rows, hint] = await Promise.all([
    ctx.db.WorkScheduleDay.findAll({
      where: { companyId: ctx.company.id, scopeType: scope.scopeType, scopeId: scope.scopeId },
      order: [['weekday', 'ASC']],
    }),
    inheritHint(ctx, scope),
  ]);

  const byWeekday = {};
  rows.forEach((r) => { byWeekday[r.weekday] = r; });

  return schedule.WEEKDAYS.map((d) => {
    const row = byWeekday[d.value];
    return {
      weekday: d.value,
      label: d.label,
      mode: row ? (row.isWorkingDay === false ? 'off' : 'work') : 'inherit',
      start: row ? row.startTime || '' : '',
      end: row ? row.endTime || '' : '',
      inherited_label: hint[d.value] || 'not configured',
    };
  });
}

/**
 * Effective timezone for the scope being configured. For an employee that is the
 * employee's own centre/company chain (not the acting admin's), so the admin sees
 * the zone that employee's times will actually be shown in.
 */
async function scopeTimezoneInfo(ctx, scope) {
  if (scope.scopeType === 'user') {
    const employee = await ctx.db.User.findOne({
      where: { id: scope.scopeId, companyId: ctx.company.id },
    });
    if (!employee) return null;
    const workCenter = employee.workCenterId
      ? await ctx.db.WorkCenter.findOne({
        where: { id: employee.workCenterId, companyId: ctx.company.id },
      })
      : null;
    const info = schedule.resolveTimezoneInfo({ workCenter, company: ctx.company });
    return {
      timezone: info.timezone,
      source_label: schedule.TIMEZONE_LABELS[info.source],
      subject_label: employee.full_name(),
    };
  }

  // Departments have no timezone of their own; the company applies.
  const info = schedule.resolveTimezoneInfo({ company: ctx.company });
  return {
    timezone: info.timezone,
    source_label: schedule.TIMEZONE_LABELS[info.source],
    subject_label: null,
  };
}

router.get('/schedule/', requirePermission('time.schedules.manage'), asyncHandler(async (req, res) => {
  const ctx = await buildContext(req);
  const scope = parseScope(req.query.scope, ctx);

  if (!scope || !(await scopeBelongsToCompany(ctx, scope))) {
    req.session.flash_error('Unknown schedule scope.');
    return res.redirect_with_session('/time/schedule/');
  }

  const [week, options, scopeTimezone] = await Promise.all([
    loadWeek(ctx, scope),
    loadScopeOptions(ctx),
    scopeTimezoneInfo(ctx, scope),
  ]);
  const selectedScope = scope.scopeType === 'company'
    ? 'company'
    : scope.scopeType + ':' + scope.scopeId;

  res.render('time/schedule', {
    active_nav: 'time',
    timezone: ctx.timezone,
    scope_timezone: scopeTimezone,
    week,
    selected_scope: selectedScope,
    department_options: options.departments,
    user_options: options.users,
    has_any: week.some((d) => d.mode !== 'inherit'),
  });
}));

const MODES = ['inherit', 'work', 'off'];

/**
 * Persist the expected week for one scope.
 * Per weekday the admin chooses one of three explicit states:
 *   inherit -> no row here, the wider scope applies
 *   work    -> working day with hours
 *   off     -> explicit non-working day (stops inheritance)
 */
async function saveWeek({ ctx, scope, body }) {
  const rows = [];

  for (const day of schedule.WEEKDAYS) {
    const mode = body['mode_' + day.value] || 'inherit';
    if (!MODES.includes(mode)) {
      throw Object.assign(new Error('Unknown mode for ' + day.label), { code: 'INVALID_MODE', day: day.label });
    }
    if (mode === 'inherit') continue;

    if (mode === 'off') {
      rows.push({
        companyId: ctx.company.id,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        weekday: day.value,
        isWorkingDay: false,
        startTime: null,
        endTime: null,
      });
      continue;
    }

    const start = (body['start_' + day.value] || '').trim();
    const end = (body['end_' + day.value] || '').trim();
    if (!schedule.isValidTime(start) || !schedule.isValidTime(end)) {
      throw Object.assign(new Error('Invalid time for ' + day.label), { code: 'INVALID_TIME', day: day.label });
    }
    if (start >= end) {
      throw Object.assign(new Error('Start must be before end for ' + day.label), { code: 'INVALID_RANGE', day: day.label });
    }
    rows.push({
      companyId: ctx.company.id,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      weekday: day.value,
      isWorkingDay: true,
      startTime: start,
      endTime: end,
    });
  }

  return ctx.db.sequelize.transaction(async (transaction) => {
    await ctx.db.WorkScheduleDay.destroy({
      where: { companyId: ctx.company.id, scopeType: scope.scopeType, scopeId: scope.scopeId },
      transaction,
    });
    if (rows.length) {
      await ctx.db.WorkScheduleDay.bulkCreate(rows, { transaction });
    }
    return rows.length;
  });
}

function scopeBackLink(scope) {
  return scope.scopeType === 'company' ? 'company' : scope.scopeType + ':' + scope.scopeId;
}

router.post('/schedule/', requirePermission('time.schedules.manage'), asyncHandler(async (req, res) => {
  const ctx = await buildContext(req);
  const scope = parseScope(req.body && req.body.scope, ctx);

  if (!scope || !(await scopeBelongsToCompany(ctx, scope))) {
    req.session.flash_error('Unknown schedule scope.');
    return res.redirect_with_session('/time/schedule/');
  }

  try {
    const count = await saveWeek({ ctx, scope, body: req.body || {} });
    req.session.flash_message(count
      ? 'Expected schedule saved (' + count + ' day' + (count === 1 ? '' : 's') + ' set for this scope).'
      : 'Expected schedule cleared: every day inherits from the wider scope.');
  } catch (err) {
    if (['INVALID_TIME', 'INVALID_RANGE', 'INVALID_MODE'].includes(err.code)) {
      req.session.flash_error(err.message + '. Use HH:MM and make sure start is before end.');
    } else {
      console.error('Failed to save expected schedule: ' + err);
      req.session.flash_error('Failed to save the expected schedule.');
    }
  }

  return res.redirect_with_session('/time/schedule/?scope=' + encodeURIComponent(scopeBackLink(scope)));
}));

/*
 * Explicit office template (Mon-Fri 09:00-17:00, Sat/Sun explicitly non-working).
 * Admin-triggered, for the chosen scope only: we never inject working-time data
 * into existing companies/employees silently. Saving it is an explicit,
 * reversible action by an administrator.
 */
router.post('/schedule/template/', requirePermission('time.schedules.manage'), asyncHandler(async (req, res) => {
  const ctx = await buildContext(req);
  const scope = parseScope(req.body && req.body.scope, ctx);

  if (!scope || !(await scopeBelongsToCompany(ctx, scope))) {
    req.session.flash_error('Unknown schedule scope.');
    return res.redirect_with_session('/time/schedule/');
  }

  const body = {};
  [1, 2, 3, 4, 5].forEach((wd) => {
    body['mode_' + wd] = 'work';
    body['start_' + wd] = '09:00';
    body['end_' + wd] = '17:00';
  });
  [6, 7].forEach((wd) => { body['mode_' + wd] = 'off'; });

  try {
    await saveWeek({ ctx, scope, body });
    req.session.flash_message('Office template applied (Mon–Fri 09:00–17:00, weekend non-working). Adjust it if needed.');
  } catch (err) {
    console.error('Failed to apply office template: ' + err);
    req.session.flash_error('Failed to apply the office template.');
  }

  return res.redirect_with_session('/time/schedule/?scope=' + encodeURIComponent(scopeBackLink(scope)));
}));

module.exports = router;