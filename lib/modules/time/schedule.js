'use strict';

/*
 * Expected-schedule resolution for the time-tracking module.
 *
 * Single resolution point for the hierarchy expected by product:
 *     employee > department > company      (most specific wins, per weekday)
 *
 * Only WorkScheduleDay is read here, so there is exactly one source of truth for
 * planned hours inside this module (see the model comment for why Schedule, the
 * absence model, is intentionally not reused for hours).
 *
 * Two distinct states are preserved, because "inherit from the wider scope" and
 * "explicitly not a working day" are different answers:
 *   - no row for that weekday in ANY scope  -> null        (nothing configured)
 *   - the most specific row is `is_working_day = false`     -> { working: false }
 *   - the most specific row has hours                       -> { working: true, ... }
 * A part-time employee (works Mondays only) therefore stores an explicit
 * non-working row for Tue-Fri instead of silently inheriting the company week.
 *
 * Weekdays are computed in the effective timezone (work centre -> company -> UTC),
 * never in UTC: 23:30Z on Sunday is already Monday in Madrid.
 */

const moment = require('moment-timezone');
const { Op } = require('sequelize');

const WEEKDAYS = [
  { value: 1, label: 'Monday', short: 'Mon' },
  { value: 2, label: 'Tuesday', short: 'Tue' },
  { value: 3, label: 'Wednesday', short: 'Wed' },
  { value: 4, label: 'Thursday', short: 'Thu' },
  { value: 5, label: 'Friday', short: 'Fri' },
  { value: 6, label: 'Saturday', short: 'Sat' },
  { value: 7, label: 'Sunday', short: 'Sun' },
];

const SCOPE_PRIORITY = { user: 3, department: 2, company: 1 };

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isValidTime(value) {
  return typeof value === 'string' && TIME_RE.test(value);
}

/** ISO weekday (1=Mon..7=Sun) of an instant, in the given timezone. */
function isoWeekdayInZone(date, timezone) {
  return moment.utc(date || new Date()).tz(timezone || 'UTC').isoWeekday();
}

/**
 * Resolve the expected schedule for a user on a given instant.
 * @returns {Promise<null | {weekday:number, working:boolean, startTime:string|null,
 *          endTime:string|null, source:'user'|'department'|'company'}>}
 */
async function resolveScheduleForUser({ models, user, date, timezone }) {
  const companyId = user.companyId;
  const zone = timezone || 'UTC';
  const weekday = isoWeekdayInZone(date, zone);

  const scopes = [{ scopeType: 'user', scopeId: user.id }];
  if (user.DepartmentId) {
    scopes.push({ scopeType: 'department', scopeId: user.DepartmentId });
  }
  scopes.push({ scopeType: 'company', scopeId: companyId });

  const rows = await models.WorkScheduleDay.findAll({
    where: { companyId, weekday, [Op.or]: scopes },
  });

  if (!rows.length) return null;

  rows.sort((a, b) => (SCOPE_PRIORITY[b.scopeType] || 0) - (SCOPE_PRIORITY[a.scopeType] || 0));
  const best = rows[0];

  return {
    weekday: best.weekday,
    working: best.isWorkingDay !== false,
    startTime: best.startTime || null,
    endTime: best.endTime || null,
    source: best.scopeType,
  };
}

/**
 * Full week for a user, applying the same hierarchy per weekday.
 *
 * The reference instants are built *in the target zone* (not in UTC): a fixed
 * UTC anchor would fall on the next local day for zones ahead of UTC, and then
 * Monday would resolve Tuesday's row (Pacific/Auckland, Pacific/Kiritimati).
 *
 * @returns {Promise<Array<null|{weekday,working,startTime,endTime,source}>>} index 0 = Monday
 */
async function resolveWeekForUser({ models, user, timezone }) {
  const zone = timezone || 'UTC';
  const out = [];
  // 2024-01-01 is a Monday. Noon local avoids any DST/offset edge at midnight.
  const mondayNoon = moment.tz('2024-01-01T12:00:00', zone);

  for (const day of WEEKDAYS) {
    const ref = mondayNoon.clone().add(day.value - 1, 'days').toDate();
    const resolved = await resolveScheduleForUser({ models, user, date: ref, timezone: zone });
    out.push(resolved);
  }
  return out;
}

/** Effective timezone: work centre, then company, then UTC. */
function resolveTimezone({ workCenter, company }) {
  return resolveTimezoneInfo({ workCenter, company }).timezone;
}

/**
 * Effective timezone together with where it comes from, so the UI can explain
 * the value instead of showing a bare string.
 * @returns {{timezone: string, source: 'workCenter'|'company'|'UTC'}}
 */
function resolveTimezoneInfo({ workCenter, company }) {
  if (workCenter && workCenter.timezone) {
    return { timezone: workCenter.timezone, source: 'workCenter' };
  }
  if (company && company.timezone) {
    return { timezone: company.timezone, source: 'company' };
  }
  return { timezone: 'UTC', source: 'UTC' };
}

const TIMEZONE_LABELS = {
  workCenter: 'work centre',
  company: 'company',
  UTC: 'UTC (fallback, no timezone configured)',
};

/** True when the value is an IANA zone known to moment-timezone. */
function isValidTimezone(value) {
  return typeof value === 'string' && moment.tz.names().indexOf(value) >= 0;
}

function formatTimeInZone(instant, timezone) {
  return moment.utc(instant).tz(timezone || 'UTC').format('HH:mm');
}

function formatDateInZone(instant, timezone) {
  return moment.utc(instant).tz(timezone || 'UTC').format('YYYY-MM-DD');
}

function formatDateTimeInZone(instant, timezone) {
  return moment.utc(instant).tz(timezone || 'UTC').format('YYYY-MM-DD HH:mm');
}

/** Elapsed minutes between start and end (or "now" while still open). */
function elapsedMinutes(startedAt, endedAt) {
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  return Math.max(0, Math.floor((end - start) / 60000));
}

/** Human duration. Deliberately called "elapsed", not "worked" (no pauses yet). */
function humanDuration(minutes) {
  const total = Math.max(0, Math.floor(minutes || 0));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h && m) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (h) return `${h} h`;
  return `${m} min`;
}

module.exports = {
  WEEKDAYS,
  WEEKDAY_LABELS: WEEKDAYS.reduce((acc, d) => { acc[d.value] = d.label; return acc; }, {}),
  SCOPE_PRIORITY,
  TIMEZONE_LABELS,
  isValidTime,
  isValidTimezone,
  isoWeekdayInZone,
  resolveScheduleForUser,
  resolveWeekForUser,
  resolveTimezone,
  resolveTimezoneInfo,
  formatTimeInZone,
  formatDateInZone,
  formatDateTimeInZone,
  elapsedMinutes,
  humanDuration,
};