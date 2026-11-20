'use strict';

/*
 * Corrections of recorded work sessions (block 3).
 *
 * PRINCIPLE: THE ORIGINAL IS NEVER DESTROYED.
 *
 * A correction is a REQUEST (time_corrections row) that keeps the original
 * value, the proposed value, the reason, the policy in force when it was
 * submitted and who resolved it. Applying it changes the effective projection
 * (time_entries / time_breaks) and appends a 'correction' event to the session
 * timeline; the original 'in' / 'out' / 'break_start' / 'break_end' events stay
 * exactly as they were written, so the day as it was originally recorded can
 * always be reconstructed.
 *
 * POLICY (per company, see time_correction_policies):
 *   'self_service'      -> the request is created AND applied in one transaction.
 *   'approval_required' -> the request waits for a supervisor (the default).
 *
 * CONFLICTS: a request is written against a snapshot of the value it corrects.
 * When it is resolved, the current value is compared with that snapshot inside
 * the same transaction that holds the row lock. If they differ, the correction
 * is NOT applied blindly: the request is preserved with status 'conflict' and a
 * human has to look at it.
 *
 * RESOLUTION is atomic and safe under repetition: the request is claimed with a
 * conditional UPDATE (WHERE status = 'pending'), so two concurrent approvals (or
 * an approval racing a rejection) cannot both win.
 *
 * AUTHORISATION is enforced here, not only in the routes: a request can only be
 * resolved by a supervisor of the employee (department boss or Department
 * Supervisor) or by an owner/admin of the company.
 *
 * ADMINISTRATIVE SELF-APPROVAL: the requester may resolve their OWN request
 * only as an explicit administrative exception, and only when they hold the
 * administrative role of the company (owner/admin) AND the request was created
 * under the 'approval_required' policy. Being a department boss, a Department
 * Supervisor or having the RBAC role 'manager' NEVER grants it. The exception
 * is recorded in three places: the `self_approved` column of the request, an
 * explicit audit row (attribute 'administrative_self_approval') and the
 * payload of the correction event.
 */

const moment = require('moment-timezone');
const { Op } = require('sequelize');

const { can, roleOf } = require('../../auth/permissions');
const { lockTimeEntry, lockUserScope } = require('./locks');
const breaksModule = require('./breaks');
const clockModule = require('./clock');

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

const MODES = {
  SELF_SERVICE: 'self_service',
  APPROVAL_REQUIRED: 'approval_required',
};
const MODE_VALUES = [MODES.SELF_SERVICE, MODES.APPROVAL_REQUIRED];
const DEFAULT_MODE = MODES.APPROVAL_REQUIRED;

const TYPES = [
  {
    value: 'entry_start',
    label: 'Clock-in time',
    scope: 'entry',
    description: 'The time you clocked in was wrong.',
  },
  {
    value: 'entry_end',
    label: 'Clock-out time',
    scope: 'entry',
    description: 'The time you clocked out was wrong, or you forgot to clock out.',
  },
  {
    value: 'missing_entry',
    label: 'Forgotten work session',
    scope: 'none',
    description: 'You forgot to clock in and out for a whole day.',
  },
  {
    value: 'break_start',
    label: 'Break start time',
    scope: 'break',
    description: 'A break started at the wrong time.',
  },
  {
    value: 'break_end',
    label: 'Break end time',
    scope: 'break',
    description: 'A break finished at the wrong time, or you forgot to finish it.',
  },
  {
    value: 'break_type',
    label: 'Break type',
    scope: 'break',
    description: 'A break was recorded with the wrong type.',
  },
  {
    value: 'break_missing',
    label: 'Forgotten break',
    scope: 'entry',
    description: 'You forgot to record a break.',
  },
  {
    value: 'modality',
    label: 'Work modality',
    scope: 'entry',
    description: 'The work modality (office, remote, travel) was wrong.',
  },
];
const TYPE_VALUES = TYPES.map((t) => t.value);

const STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  APPLIED: 'applied',
  CONFLICT: 'conflict',
  CANCELLED: 'cancelled',
};

const STATUS_LABELS = {
  pending: 'Pending approval',
  approved: 'Approved (being applied)',
  rejected: 'Rejected',
  applied: 'Applied',
  conflict: 'Conflict — needs review',
  cancelled: 'Cancelled by the requester',
};

const MODE_LABELS = {
  self_service: 'Self-service (applied immediately)',
  approval_required: 'Approval required (supervisor decides)',
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function correctionError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function isUniqueViolation(err) {
  if (!err) return false;
  if (err.name === 'SequelizeUniqueConstraintError') return true;
  return /unique constraint|SQLITE_CONSTRAINT/i.test(String(err.message || ''));
}

function labelOfType(type) {
  const found = TYPES.find((t) => t.value === type);
  return found ? found.label : type;
}

function iso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (e) {
    return null;
  }
}

function truncate(value, max) {
  if (value === null || value === undefined) return null;
  const limit = max || 255;
  return String(value).slice(0, limit);
}

/**
 * Build an instant from a local civil date + time in the effective timezone.
 *
 * The browser never sends an instant: it sends "2026-03-30 09:00" and the server
 * decides what that means in the employee's effective zone. A time that does not
 * exist (DST spring-forward gap) is rejected instead of being silently shifted.
 */
function instantFromLocal({ date, time, timezone }) {
  if (!DATE_RE.test(String(date || '')) || !TIME_RE.test(String(time || ''))) return null;
  const zone = timezone || 'UTC';
  const m = moment.tz(`${date} ${time}`, 'YYYY-MM-DD HH:mm', zone);
  if (!m.isValid()) return null;
  if (m.format('YYYY-MM-DD HH:mm') !== `${date} ${time}`) return null;
  return m.toDate();
}

function localDateOf(instant, timezone) {
  return moment.utc(instant).tz(timezone || 'UTC').format('YYYY-MM-DD');
}

function localTimeOf(instant, timezone) {
  return moment.utc(instant).tz(timezone || 'UTC').format('HH:mm');
}

// ---------------------------------------------------------------------------
// Company policy
// ---------------------------------------------------------------------------

/** Effective policy for a company. Absent row = the explicit default. */
async function getPolicy({ models, companyId, transaction }) {
  const row = await models.TimeCorrectionPolicy.findOne({ where: { companyId }, transaction });
  return row ? row.mode : DEFAULT_MODE;
}

/**
 * Save the company policy.
 *
 * Changing it never approves pending requests, never reverts applied ones and
 * never touches the history: every request keeps the policy that applied when
 * it was submitted (time_corrections.policy).
 */
async function setPolicy({ models, companyId, mode }) {
  if (!MODE_VALUES.includes(mode)) {
    throw correctionError('INVALID_MODE', 'Unknown correction policy.');
  }
  const sequelize = models.sequelize || models.Company.sequelize;

  return sequelize.transaction(async (transaction) => {
    // Serialise with a concurrent save, so two requests cannot leave a mixture
    // of both values.
    if (sequelize.getDialect() === 'postgres') {
      await models.Company.findByPk(companyId, { transaction, lock: transaction.LOCK.UPDATE });
    } else {
      await sequelize.query('UPDATE "Companies" SET "name" = "name" WHERE "id" = ?', {
        replacements: [companyId],
        transaction,
      });
    }

    const existing = await models.TimeCorrectionPolicy.findOne({ where: { companyId }, transaction });
    if (existing) {
      existing.mode = mode;
      await existing.save({ transaction });
    } else {
      await models.TimeCorrectionPolicy.create({ companyId, mode }, { transaction });
    }
    return mode;
  });
}

// ---------------------------------------------------------------------------
// Loading the targets (tenant + ownership are enforced here)
// ---------------------------------------------------------------------------

async function loadEntry({ models, actor, entryId, transaction }) {
  const id = parseInt(entryId, 10);
  if (!Number.isInteger(id)) {
    throw correctionError('ENTRY_NOT_FOUND', 'Unknown work session.');
  }
  const entry = await models.TimeEntry.findOne({
    where: { id, companyId: actor.companyId, userId: actor.id },
    transaction,
  });
  if (!entry) throw correctionError('ENTRY_NOT_FOUND', 'Unknown work session.');
  return entry;
}

async function loadBreak({ models, actor, breakId, transaction }) {
  const id = parseInt(breakId, 10);
  if (!Number.isInteger(id)) {
    throw correctionError('BREAK_NOT_FOUND', 'Unknown break.');
  }
  const brk = await models.TimeBreak.findOne({
    where: { id, companyId: actor.companyId, userId: actor.id },
    transaction,
  });
  if (!brk) throw correctionError('BREAK_NOT_FOUND', 'Unknown break.');

  const entry = await models.TimeEntry.findOne({
    where: { id: brk.timeEntryId, companyId: actor.companyId, userId: actor.id },
    transaction,
  });
  if (!entry) throw correctionError('BREAK_NOT_FOUND', 'Unknown break.');
  return { brk, entry };
}

async function breaksOfEntry({ models, companyId, entryId, transaction }) {
  return models.TimeBreak.findAll({
    where: { companyId, timeEntryId: entryId },
    order: [['started_at', 'ASC'], ['id', 'ASC']],
    transaction,
  });
}

/** Other sessions of the same employee (the ones that must not overlap). */
async function otherSessions({ models, companyId, userId, excludeEntryId, transaction }) {
  const where = { companyId, userId };
  if (excludeEntryId) where.id = { [Op.ne]: excludeEntryId };
  return models.TimeEntry.findAll({ where, order: [['started_at', 'ASC']], transaction });
}

function sessionOverlaps(session, startMs, endMs) {
  const sStart = new Date(session.startedAt).getTime();
  const sEnd = session.endedAt ? new Date(session.endedAt).getTime() : Infinity;
  return startMs < sEnd && sStart < endMs;
}

function breakOverlaps(brk, startMs, endMs) {
  const bStart = new Date(brk.startedAt).getTime();
  const bEnd = brk.endedAt ? new Date(brk.endedAt).getTime() : Infinity;
  return startMs < bEnd && bStart < endMs;
}

// ---------------------------------------------------------------------------
// Validation of a proposal against the CURRENT state
//
// Used twice: when the request is created and again when it is applied. The
// second run is what detects a stale request (the session changed meanwhile).
// ---------------------------------------------------------------------------

/**
 * @returns {string|null} null when the proposal is valid, otherwise the reason.
 */
function validateProposal({ type, entry, brk, breaks, proposed, now, others }) {
  const nowMs = now.getTime();

  switch (type) {
    case 'entry_start': {
      const start = new Date(proposed.startedAt).getTime();
      if (start > nowMs) return 'The new clock-in cannot be in the future.';
      const end = entry.endedAt ? new Date(entry.endedAt).getTime() : null;
      if (end !== null && start >= end) {
        return 'The new clock-in must be before the clock-out of the session.';
      }
      const outside = breaks.find((b) => new Date(b.startedAt).getTime() < start);
      if (outside) {
        return 'A break of this session starts before the new clock-in. Correct that break first.';
      }
      const clash = others.find((s) => sessionOverlaps(s, start, end === null ? Infinity : end));
      if (clash) {
        return 'The new clock-in would overlap another work session of the same employee.';
      }
      return null;
    }

    case 'entry_end': {
      const end = new Date(proposed.endedAt).getTime();
      if (end > nowMs) return 'The declared clock-out cannot be in the future.';
      const start = new Date(entry.startedAt).getTime();
      if (end <= start) return 'The declared clock-out must be after the clock-in.';
      const active = breaks.find((b) => !b.endedAt);
      if (active) {
        return 'There is an active break in this session. Finish or correct that break before declaring the clock-out.';
      }
      const outside = breaks.find((b) => b.endedAt && new Date(b.endedAt).getTime() > end);
      if (outside) {
        return 'A break of this session ends after the declared clock-out. Correct that break first.';
      }
      const clash = others.find((s) => sessionOverlaps(s, start, end));
      if (clash) {
        return 'The declared clock-out would overlap another work session of the same employee.';
      }
      return null;
    }

    case 'missing_entry': {
      const start = new Date(proposed.startedAt).getTime();
      const end = new Date(proposed.endedAt).getTime();
      if (end <= start) return 'The declared session must end after it starts.';
      if (end > nowMs) return 'The declared session cannot end in the future.';
      const clash = others.find((s) => sessionOverlaps(s, start, end));
      if (clash) {
        return 'The declared session overlaps another work session of the same employee.';
      }
      return null;
    }

    case 'break_start': {
      const start = new Date(proposed.startedAt).getTime();
      if (start > nowMs) return 'The new break start cannot be in the future.';
      const entryStart = new Date(entry.startedAt).getTime();
      if (start < entryStart) return 'The break cannot start before the work session.';
      const brkEnd = brk.endedAt ? new Date(brk.endedAt).getTime() : Infinity;
      if (brkEnd !== Infinity && start >= brkEnd) {
        return 'The new break start must be before the break end.';
      }
      const clash = breaks.find((b) => b.id !== brk.id && breakOverlaps(b, start, brkEnd));
      if (clash) return 'The corrected break would overlap another break of the session.';
      return null;
    }

    case 'break_end': {
      const end = new Date(proposed.endedAt).getTime();
      if (end > nowMs) return 'The new break end cannot be in the future.';
      const breakStart = new Date(brk.startedAt).getTime();
      if (end <= breakStart) return 'The new break end must be after the break start.';
      const entryEnd = entry.endedAt ? new Date(entry.endedAt).getTime() : null;
      if (entryEnd !== null && end > entryEnd) {
        return 'The break cannot end after the work session.';
      }
      const clash = breaks.find((b) => b.id !== brk.id && breakOverlaps(b, breakStart, end));
      if (clash) return 'The corrected break would overlap another break of the session.';
      return null;
    }

    case 'break_type': {
      if (!breaksModule.BREAK_TYPE_VALUES.includes(proposed.type)) {
        return 'Unknown break type.';
      }
      return null;
    }

    case 'break_missing': {
      const start = new Date(proposed.startedAt).getTime();
      const end = new Date(proposed.endedAt).getTime();
      if (end <= start) return 'The declared break must end after it starts.';
      if (end > nowMs) return 'The declared break cannot end in the future.';
      const entryStart = new Date(entry.startedAt).getTime();
      const entryEnd = entry.endedAt ? new Date(entry.endedAt).getTime() : null;
      if (start < entryStart) return 'The declared break must start inside the work session.';
      if (entryEnd !== null && end > entryEnd) {
        return 'The declared break must end inside the work session.';
      }
      if (!breaksModule.BREAK_TYPE_VALUES.includes(proposed.type)) return 'Unknown break type.';
      const clash = breaks.find((b) => breakOverlaps(b, start, end));
      if (clash) return 'The declared break would overlap another break of the session.';
      return null;
    }

    case 'modality': {
      if (!clockModule.MODALITY_VALUES.includes(proposed.modality)) return 'Unknown work modality.';
      return null;
    }

    default:
      return 'Unknown correction type.';
  }
}

// ---------------------------------------------------------------------------
// Building a request
// ---------------------------------------------------------------------------

/**
 * Turn the employee's declaration into an instant-based proposal plus the
 * snapshot of the value it corrects.
 */
async function buildProposal({ models, actor, type, entryId, breakId, input, timezone, now, transaction }) {
  const zone = timezone || 'UTC';
  const data = input || {};

  let entry = null;
  let brk = null;

  if (type === 'break_start' || type === 'break_end' || type === 'break_type') {
    const loaded = await loadBreak({ models, actor, breakId, transaction });
    brk = loaded.brk;
    entry = loaded.entry;
  } else if (type !== 'missing_entry') {
    // A forgotten session has no session yet: there is nothing to load.
    entry = await loadEntry({ models, actor, entryId, transaction });
  }

  const entryBreaks = entry
    ? await breaksOfEntry({
      models, companyId: actor.companyId, entryId: entry.id, transaction,
    })
    : [];

  const others = await otherSessions({
    models, companyId: actor.companyId, userId: actor.id,
    excludeEntryId: entry ? entry.id : null, transaction,
  });

  let original = null;
  let proposed = null;
  let targetKey = null;

  switch (type) {
    case 'entry_start': {
      const date = data.date || localDateOf(entry.startedAt, zone);
      const instant = instantFromLocal({ date, time: data.time, timezone: zone });
      if (!instant) {
        throw correctionError('INVALID_TIME', 'The declared clock-in is not a valid date and time.');
      }
      original = { startedAt: iso(entry.startedAt) };
      proposed = { startedAt: iso(instant), localDate: date, localTime: data.time };
      targetKey = `entry:${entry.id}:start`;
      break;
    }

    case 'entry_end': {
      const date = data.date || localDateOf(entry.startedAt, zone);
      const instant = instantFromLocal({ date, time: data.time, timezone: zone });
      if (!instant) {
        throw correctionError('INVALID_TIME', 'The declared clock-out is not a valid date and time.');
      }
      original = { endedAt: iso(entry.endedAt) };
      proposed = { endedAt: iso(instant), localDate: date, localTime: data.time };
      targetKey = `entry:${entry.id}:end`;
      break;
    }

    case 'missing_entry': {
      const date = data.date;
      const startInstant = instantFromLocal({ date, time: data.time, timezone: zone });
      if (!startInstant) {
        throw correctionError('INVALID_TIME', 'The declared session start is not a valid date and time.');
      }
      const endDate = data.end_time < data.time
        ? moment.utc(date, 'YYYY-MM-DD', true).add(1, 'day').format('YYYY-MM-DD')
        : date;
      const endInstant = instantFromLocal({ date: endDate, time: data.end_time, timezone: zone });
      if (!endInstant) {
        throw correctionError('INVALID_TIME', 'The declared session end is not a valid date and time.');
      }
      const end = endInstant;
      const modality = clockModule.MODALITY_VALUES.includes(data.modality) ? data.modality : 'office';
      original = null;
      proposed = {
        date,
        startedAt: iso(startInstant),
        endedAt: iso(end),
        startTime: data.time,
        endTime: data.end_time,
        modality,
      };
      targetKey = `missing:${date}`;
      break;
    }

    case 'break_start': {
      const date = data.date || localDateOf(brk.startedAt, zone);
      const instant = instantFromLocal({ date, time: data.time, timezone: zone });
      if (!instant) {
        throw correctionError('INVALID_TIME', 'The declared break start is not a valid date and time.');
      }
      original = { startedAt: iso(brk.startedAt) };
      proposed = { startedAt: iso(instant), localDate: date, localTime: data.time };
      targetKey = `break:${brk.id}:start`;
      break;
    }

    case 'break_end': {
      const date = data.date || localDateOf(brk.startedAt, zone);
      const instant = instantFromLocal({ date, time: data.time, timezone: zone });
      if (!instant) {
        throw correctionError('INVALID_TIME', 'The declared break end is not a valid date and time.');
      }
      original = { endedAt: iso(brk.endedAt) };
      proposed = { endedAt: iso(instant), localDate: date, localTime: data.time };
      targetKey = `break:${brk.id}:end`;
      break;
    }

    case 'break_type': {
      if (!breaksModule.BREAK_TYPE_VALUES.includes(data.break_type)) {
        throw correctionError('INVALID_TYPE', 'Choose a valid break type.');
      }
      // The snapshot of the counting criterion is kept as part of the original
      // value: correcting the type never rewrites how the break was counted.
      original = { type: brk.type, countsAsWork: brk.countsAsWork === true };
      proposed = { type: data.break_type };
      targetKey = `break:${brk.id}:type`;
      break;
    }

    case 'break_missing': {
      const date = data.date || localDateOf(entry.startedAt, zone);
      const startInstant = instantFromLocal({ date, time: data.time, timezone: zone });
      if (!startInstant) {
        throw correctionError('INVALID_TIME', 'The declared break start is not a valid date and time.');
      }
      const endDate = data.end_time < data.time
        ? moment.utc(date, 'YYYY-MM-DD', true).add(1, 'day').format('YYYY-MM-DD')
        : date;
      const endInstant = instantFromLocal({ date: endDate, time: data.end_time, timezone: zone });
      if (!endInstant) {
        throw correctionError('INVALID_TIME', 'The declared break end is not a valid date and time.');
      }
      if (!breaksModule.BREAK_TYPE_VALUES.includes(data.break_type)) {
        throw correctionError('INVALID_TYPE', 'Choose a valid break type.');
      }
      original = null;
      proposed = {
        startedAt: iso(startInstant),
        endedAt: iso(endInstant),
        type: data.break_type,
        localDate: date,
        startTime: data.time,
        endTime: data.end_time,
      };
      targetKey = `entry:${entry.id}:break`;
      break;
    }

    case 'modality': {
      if (!clockModule.MODALITY_VALUES.includes(data.modality)) {
        throw correctionError('INVALID_MODALITY', 'Choose a valid work modality.');
      }
      original = { modality: entry.modality };
      proposed = { modality: data.modality };
      targetKey = `entry:${entry.id}:modality`;
      break;
    }

    default:
      throw correctionError('INVALID_TYPE', 'Unknown correction type.');
  }

  // The proposal must be valid against the CURRENT state.
  const problem = validateProposal({
    type, entry, brk, breaks: entryBreaks, proposed, now, others,
  });
  if (problem) throw correctionError('INVALID_PROPOSAL', problem);

  // "Nothing to correct" is refused: it would only pollute the history.
  if (original && sameValue(type, original, proposed)) {
    throw correctionError('NO_CHANGE', 'The proposed value is the same as the recorded one.');
  }

  return { entry, brk, original, proposed, targetKey };
}

/** Is the proposed value identical to the recorded one? */
function sameValue(type, original, proposed) {
  switch (type) {
    case 'entry_start':
    case 'break_start':
      return original.startedAt === proposed.startedAt;
    case 'entry_end':
    case 'break_end':
      return (original.endedAt || null) === (proposed.endedAt || null);
    case 'modality':
      return original.modality === proposed.modality;
    case 'break_type':
      return original.type === proposed.type;
    default:
      return false;
  }
}

/**
 * Create a correction request.
 *
 * With the 'self_service' policy the request is applied immediately, in the
 * same transaction, so there is no window in which a request is "approved" but
 * not applied. With 'approval_required' nothing changes in the effective data:
 * a pending request does not alter the computation.
 */
async function createRequest({ models, actor, type, entryId, breakId, input, timezone, now }) {
  const serverNow = now || new Date();
  const zone = timezone || 'UTC';

  if (!TYPE_VALUES.includes(type)) throw correctionError('INVALID_TYPE', 'Unknown correction type.');

  const reason = String((input && input.reason) || '').trim();
  if (!reason) throw correctionError('REASON_REQUIRED', 'Please explain why the correction is needed.');
  if (reason.length > 2000) throw correctionError('REASON_TOO_LONG', 'The reason is too long.');

  const sequelize = models.sequelize;

  return sequelize.transaction(async (transaction) => {
    await lockUserScope({ models, userId: actor.id, transaction });
    if (sequelize.getDialect() === 'postgres') {
      await models.Company.findByPk(actor.companyId, { transaction, lock: transaction.LOCK.SHARE });
    }
    const policy = await getPolicy({ models, companyId: actor.companyId, transaction });
    const built = await buildProposal({
      models, actor, type, entryId, breakId, input, timezone: zone, now: serverNow, transaction,
    });

    let correction;
    try {
      correction = await models.TimeCorrection.create({
        companyId: actor.companyId,
        userId: actor.id,
        timeEntryId: built.entry ? built.entry.id : null,
        timeBreakId: built.brk ? built.brk.id : null,
        type,
        status: STATUS.PENDING,
        targetKey: built.targetKey,
        originalValue: built.original ? JSON.stringify(built.original) : null,
        proposedValue: JSON.stringify(built.proposed),
        reason,
        policy,
        entryVersion: built.entry ? built.entry.version : null,
      }, { transaction });
    } catch (err) {
      // One pending request per target: the database refuses the duplicate.
      if (isUniqueViolation(err)) {
        throw correctionError('DUPLICATE_PENDING', 'There is already a pending request for this record.');
      }
      throw err;
    }

    if (policy !== MODES.SELF_SERVICE) {
      return { correction, applied: false };
    }

    const outcome = await applyCorrection({
      models, correction, actor, now: serverNow, transaction,
    });

    if (!outcome.applied) {
      await models.TimeCorrection.update({
        status: STATUS.CONFLICT, conflictReason: outcome.conflict,
      }, { where: { id: correction.id }, transaction });

      await writeAuditRows({
        models, correction, actor, transaction,
        fromStatus: STATUS.PENDING, toStatus: STATUS.CONFLICT,
        proposed: parseJson(correction.proposedValue),
      });
    }

    const fresh = await models.TimeCorrection.findByPk(correction.id, { transaction });
    return { correction: fresh, applied: outcome.applied };
  });
}

// ---------------------------------------------------------------------------
// Applying a correction
// ---------------------------------------------------------------------------

/** Compare the snapshot the request was written against with the current value. */
function detectMismatch({ type, original, entry, brk }) {
  if (!original) return null;
  switch (type) {
    case 'entry_start':
      return original.startedAt === iso(entry.startedAt)
        ? null : 'The clock-in time changed after this request was created.';
    case 'entry_end':
      return original.endedAt === iso(entry.endedAt)
        ? null : 'The clock-out time changed after this request was created.';
    case 'modality':
      return original.modality === entry.modality
        ? null : 'The work modality changed after this request was created.';
    case 'break_start':
      return original.startedAt === iso(brk.startedAt)
        ? null : 'The break start changed after this request was created.';
    case 'break_end':
      return original.endedAt === iso(brk.endedAt)
        ? null : 'The break end changed after this request was created.';
    case 'break_type':
      return original.type === brk.type
        ? null : 'The break type changed after this request was created.';
    default:
      return null;
  }
}

/**
 * Write the audit rows of a resolution.
 *
 * The administrative self-approval gets its OWN row: the attribute name says
 * that the request was approved by its own requester, and the value carries the
 * identity of that person and the role they were holding. It is written for
 * every decision taken on one's own request (applied or conflict), and never
 * for a request decided by somebody else.
 */
async function writeAuditRows({ models, correction, actor, transaction, fromStatus, toStatus, proposed, selfApproval }) {
  const rows = [
    { attribute: 'status', oldValue: fromStatus, newValue: toStatus },
    { attribute: 'type', oldValue: null, newValue: correction.type },
    { attribute: 'policy', oldValue: null, newValue: correction.policy },
    { attribute: 'reason', oldValue: null, newValue: correction.reason },
    { attribute: 'original_value', oldValue: null, newValue: correction.originalValue },
    { attribute: 'proposed_value', oldValue: null, newValue: proposed ? JSON.stringify(proposed) : null },
    { attribute: 'resolved_by', oldValue: null, newValue: String(actor.id) },
  ];

  if (selfApproval === true) {
    rows.push({
      attribute: 'administrative_self_approval',
      oldValue: null,
      newValue: JSON.stringify({
        selfApproved: true,
        resolvedById: actor.id,
        role: roleOf(actor),
        policy: correction.policy,
      }),
    });
  }

  for (const row of rows) {
    await models.Audit.create({
      companyId: correction.companyId,
      byUserId: actor.id,
      entityType: 'TIME_CORRECTION',
      entityId: correction.id,
      attribute: row.attribute,
      oldValue: truncate(row.oldValue),
      newValue: truncate(row.newValue),
    }, { transaction });
  }
}

async function appendCorrectionEvent({ models, correction, entry, payload, actor, now, transaction, selfApproval }) {
  await models.TimeEntryEvent.create({
    companyId: correction.companyId,
    userId: correction.userId,
    timeEntryId: entry.id,
    type: 'correction',
    occurredAt: now,
    source: 'corrected',
    modality: entry.modality,
    correctionId: correction.id,
    payload: JSON.stringify(Object.assign({
      correctionType: correction.type,
      origin: 'correction',
      requestedBy: correction.userId,
      resolvedBy: actor.id,
      reason: correction.reason,
      policy: correction.policy,
      administrativeSelfApproval: selfApproval === true,
    }, payload || {})),
  }, { transaction });
}

/**
 * Apply a request to the effective record.
 *
 * Runs inside the caller's transaction. Returns { applied: true } or
 * { applied: false, conflict: '...' } — a conflict never throws, because the
 * request must be PRESERVED for a human decision.
 *
 * `selfApproval` is true only when the caller is resolving their OWN request
 * as owner/admin (the administrative exception). It is what flags the request
 * and what writes the explicit audit row.
 */
async function applyCorrection({ models, correction, actor, now, transaction, selfApproval }) {
  const type = correction.type;
  const proposed = parseJson(correction.proposedValue);
  const original = parseJson(correction.originalValue);
  const sequelize = models.sequelize;

  if (type === 'missing_entry') {
    // No session exists yet: serialise on the employee scope and re-check that
    // nothing overlaps the declared window.
    await lockUserScope({ models, userId: correction.userId, transaction });

    const employee = await models.User.findByPk(correction.userId, { transaction });
    if (!employee) {
      return { applied: false, conflict: 'The employee no longer exists.' };
    }

    const others = await otherSessions({
      models, companyId: correction.companyId, userId: correction.userId, transaction,
    });

    const problem = validateProposal({
      type, entry: null, brk: null, breaks: [], proposed, now, others,
    });
    if (problem) return { applied: false, conflict: problem };

    const entry = await models.TimeEntry.create({
      companyId: correction.companyId,
      userId: correction.userId,
      modality: proposed.modality,
      status: 'closed',
      source: 'declared',
      version: 1,
      startedAt: new Date(proposed.startedAt),
      endedAt: new Date(proposed.endedAt),
    }, { transaction });

    // A declared session is identified as such: it is never presented as a
    // verified server clock.
    await models.TimeEntryEvent.create({
      companyId: correction.companyId,
      userId: correction.userId,
      timeEntryId: entry.id,
      type: 'in',
      occurredAt: entry.startedAt,
      source: 'declared',
      modality: entry.modality,
      correctionId: correction.id,
    }, { transaction });

    await models.TimeEntryEvent.create({
      companyId: correction.companyId,
      userId: correction.userId,
      timeEntryId: entry.id,
      type: 'out',
      occurredAt: entry.endedAt,
      source: 'declared',
      modality: entry.modality,
      correctionId: correction.id,
    }, { transaction });

    await models.TimeCorrection.update(
      { timeEntryId: entry.id },
      { where: { id: correction.id }, transaction }
    );

    await appendCorrectionEvent({
      models, correction, entry, actor, now, transaction,
      selfApproval,
      payload: {
        field: 'session',
        created: true,
        from: null,
        to: {
          startedAt: proposed.startedAt,
          endedAt: proposed.endedAt,
          modality: proposed.modality,
        },
        declaredAt: correction.createdAt ? iso(correction.createdAt) : null,
      },
    });

    await models.TimeCorrection.update({
      status: STATUS.APPLIED, resolvedAt: now, resolvedById: actor.id, conflictReason: null,
      selfApproved: selfApproval === true,
    }, { where: { id: correction.id }, transaction });

    await writeAuditRows({
      models, correction, actor, transaction,
      fromStatus: correction.status, toStatus: STATUS.APPLIED, proposed,
      selfApproval,
    });

    return { applied: true, entry };  }

  // ------------------------------------------------------------------
  // Corrections on an existing session (and possibly on one of its breaks).
  // ------------------------------------------------------------------
  const entry = await models.TimeEntry.findByPk(correction.timeEntryId, { transaction });
  if (!entry) return { applied: false, conflict: 'The work session no longer exists.' };

  // Serialise against a concurrent clock-out / break change on this session.
  await lockTimeEntry({ models, entryId: entry.id, transaction });

  const fresh = await models.TimeEntry.findByPk(entry.id, { transaction });
  if (!fresh) return { applied: false, conflict: 'The work session no longer exists.' };

  let brk = null;
  if (correction.timeBreakId) {
    brk = await models.TimeBreak.findByPk(correction.timeBreakId, { transaction });
    if (!brk) return { applied: false, conflict: 'The break no longer exists.' };
  }

  // 1. Conflict detection against the snapshot the request was written for.
  const mismatch = detectMismatch({ type, original, entry: fresh, brk });
  if (mismatch) return { applied: false, conflict: mismatch };

  // 2. Re-validate against the CURRENT state (the session may have changed in
  //    a way that does not touch the corrected value, e.g. a break was added).
  const entryBreaks = await breaksOfEntry({
    models, companyId: correction.companyId, entryId: fresh.id, transaction,
  });
  const others = await otherSessions({
    models, companyId: correction.companyId, userId: correction.userId,
    excludeEntryId: fresh.id, transaction,
  });

  const problem = validateProposal({
    type, entry: fresh, brk, breaks: entryBreaks, proposed, now, others,
  });
  if (problem) return { applied: false, conflict: problem };

  // 3. Apply.
  const versionInc = sequelize.literal('version + 1');
  let payload = null;

  switch (type) {
    case 'entry_start': {
      await models.TimeEntry.update(
        { startedAt: new Date(proposed.startedAt), version: versionInc },
        { where: { id: fresh.id }, transaction }
      );
      payload = { field: 'startedAt', from: iso(fresh.startedAt), to: proposed.startedAt };
      break;
    }

    case 'entry_end': {
      await models.TimeEntry.update(
        { endedAt: new Date(proposed.endedAt), status: 'closed', version: versionInc },
        { where: { id: fresh.id }, transaction }
      );
      payload = {
        field: 'endedAt',
        from: iso(fresh.endedAt),
        to: proposed.endedAt,
        status: 'closed',
        // The three times are deliberately distinct: when the declaration was
        // registered, what the employee declared, and what is now effective.
        declaredAt: correction.createdAt ? iso(correction.createdAt) : null,
      };
      break;
    }

    case 'modality': {
      await models.TimeEntry.update(
        { modality: proposed.modality, version: versionInc },
        { where: { id: fresh.id }, transaction }
      );
      payload = { field: 'modality', from: fresh.modality, to: proposed.modality };
      break;
    }

    case 'break_start': {
      await models.TimeBreak.update(
        { startedAt: new Date(proposed.startedAt) },
        { where: { id: brk.id }, transaction }
      );
      payload = { field: 'break.startedAt', from: iso(brk.startedAt), to: proposed.startedAt };
      break;
    }

    case 'break_end': {
      await models.TimeBreak.update(
        { endedAt: new Date(proposed.endedAt) },
        { where: { id: brk.id }, transaction }
      );
      payload = { field: 'break.endedAt', from: iso(brk.endedAt), to: proposed.endedAt };
      break;
    }

    case 'break_type': {
      // The counting criterion (counts_as_work) is NOT recomputed: the policy
      // that applied when the break happened is not reconstructible from the
      // stored data, and applying today's policy would retroactively rewrite how
      // a past break was counted — exactly what the snapshot exists to prevent.
      await models.TimeBreak.update(
        { type: proposed.type },
        { where: { id: brk.id }, transaction }
      );
      payload = {
        field: 'break.type',
        from: brk.type,
        to: proposed.type,
        countsAsWork: brk.countsAsWork === true,
        countsAsWorkKept: true,
        countsAsWorkNote: 'The counting criterion of the break was preserved.',
      };
      break;
    }

    case 'break_missing': {
      // A brand new break: the snapshot of the CURRENT break policy applies,
      // because the break is being recorded now. (The correction policy is a
      // different thing: it decides WHO resolves the request.)
      const breakPolicy = await breaksModule.getPolicy(
        models, correction.companyId, transaction
      );
      const newBreak = await models.TimeBreak.create({
        companyId: correction.companyId,
        userId: correction.userId,
        timeEntryId: fresh.id,
        type: proposed.type,
        countsAsWork: breakPolicy[proposed.type] === true,
        startedAt: new Date(proposed.startedAt),
        endedAt: new Date(proposed.endedAt),
      }, { transaction });

      await models.TimeEntryEvent.create({
        companyId: correction.companyId,
        userId: correction.userId,
        timeEntryId: fresh.id,
        type: 'break_start',
        occurredAt: newBreak.startedAt,
        source: 'corrected',
        modality: fresh.modality,
        correctionId: correction.id,
      }, { transaction });

      await models.TimeEntryEvent.create({
        companyId: correction.companyId,
        userId: correction.userId,
        timeEntryId: fresh.id,
        type: 'break_end',
        occurredAt: newBreak.endedAt,
        source: 'corrected',
        modality: fresh.modality,
        correctionId: correction.id,
      }, { transaction });

      payload = {
        field: 'break',
        created: true,
        from: null,
        to: {
          startedAt: proposed.startedAt,
          endedAt: proposed.endedAt,
          type: proposed.type,
          countsAsWork: newBreak.countsAsWork === true,
        },
      };
      break;
    }

    default:
      return { applied: false, conflict: 'Unknown correction type.' };
  }

  await appendCorrectionEvent({
    models, correction, entry: fresh, payload, actor, now, transaction,
    selfApproval,
  });

  await models.TimeCorrection.update({
    status: STATUS.APPLIED, resolvedAt: now, resolvedById: actor.id, conflictReason: null,
    selfApproved: selfApproval === true,
  }, { where: { id: correction.id }, transaction });

  await writeAuditRows({
    models, correction, actor, transaction,
    fromStatus: correction.status, toStatus: STATUS.APPLIED, proposed,
    selfApproval,
  });

  return { applied: true, entry: fresh };
}

// ---------------------------------------------------------------------------
// Authorisation and resolution
// ---------------------------------------------------------------------------

/**
 * Is the actor a supervisor of the employee who asked for the correction?
 * Department boss and Department Supervisor both count; the RBAC role alone
 * does NOT make anybody a supervisor.
 */
async function isSupervisorOf({ models, actor, employee, transaction }) {
  if (!employee || !employee.DepartmentId) return false;

  const department = await models.Department.findByPk(employee.DepartmentId, {
    transaction, ...(transaction && models.sequelize.getDialect() === 'postgres' ? { lock: transaction.LOCK.SHARE } : {}),
  });
  if (!department) return false;
  if (String(department.companyId) !== String(actor.companyId)) return false;

  if (department.bossId && String(department.bossId) === String(actor.id)) return true;

  const link = await models.DepartmentSupervisor.findOne({
    where: { department_id: department.id, user_id: actor.id },
    transaction,
    ...(transaction && models.sequelize.getDialect() === 'postgres' ? { lock: transaction.LOCK.SHARE } : {}),
  });
  return !!link;
}

/**
 * May the actor resolve this request?
 *
 * - never somebody from another company;
 * - a supervisor of the employee's department, or an owner/admin of the company;
 * - the REQUESTER themselves only as an explicit administrative exception: they
 *   must hold the administrative role of the company (owner/admin) and the
 *   request must have been created under the 'approval_required' policy.
 *   Being a department boss, a Department Supervisor or having the RBAC role
 *   'manager' NEVER grants it.
 */
async function canResolve({ models, actor, correction, transaction }) {
  if (!correction) return false;
  actor = await models.User.findByPk(actor.id, {
    transaction, ...(transaction && models.sequelize.getDialect() === 'postgres' ? { lock: transaction.LOCK.SHARE } : {}),
  });
  if (!actor) return false;
  if (String(correction.companyId) !== String(actor.companyId)) return false;

  // The administrative self-approval: reserved to owner/admin, and only under
  // the 'approval_required' policy (in 'self_service' there is no approval at
  // all: the correction is applied when it is requested).
  if (String(correction.userId) === String(actor.id)) {
    if (correction.policy !== MODES.APPROVAL_REQUIRED) return false;
    return can(actor, 'time.corrections.approve');
  }

  const employee = await models.User.findByPk(correction.userId, {
    transaction, ...(transaction && models.sequelize.getDialect() === 'postgres' ? { lock: transaction.LOCK.SHARE } : {}),
  });
  if (!employee) return false;

  if (can(actor, 'time.corrections.approve')) return true;

  return isSupervisorOf({ models, actor, employee, transaction });
}

/**
 * Resolve a request: approve (and apply) or reject.
 *
 * Atomic, idempotent and safe against concurrent resolutions: the request is
 * claimed with a conditional UPDATE on status='pending', so it can never end up
 * approved and rejected at the same time.
 *
 * The administrative self-approval (owner/admin resolving their own request
 * under 'approval_required') follows the very same path: the same temporal
 * validations, the same concurrency control and the same audit trail. It only
 * adds the explicit record of the exception.
 */
async function resolveRequest({ models, actor, correctionId, decision, reason, now }) {
  const serverNow = now || new Date();
  if (decision !== 'approve' && decision !== 'reject') {
    throw correctionError('INVALID_DECISION', 'Unknown correction decision.');
  }
  const id = parseInt(correctionId, 10);
  if (!Number.isInteger(id)) throw correctionError('NOT_FOUND', 'Unknown correction request.');

  const correction = await models.TimeCorrection.findOne({
    where: { id, companyId: actor.companyId },
  });
  if (!correction) throw correctionError('NOT_FOUND', 'Unknown correction request.');

  const isSelf = String(correction.userId) === String(actor.id);
  // The administrative self-approval only exists on an approval: rejecting
  // one's own request is not an approval.
  const selfApproval = isSelf && decision === 'approve';

  let rejectionReason = null;
  if (decision === 'reject') {
    rejectionReason = String(reason || '').trim();
    if (!rejectionReason) {
      throw correctionError('REASON_REQUIRED', 'Please give a short explanation for the rejection.');
    }
    if (rejectionReason.length > 2000) {
      throw correctionError('REASON_TOO_LONG', 'The explanation is too long.');
    }
  }

  const sequelize = models.sequelize;

  return sequelize.transaction(async (transaction) => {
    await lockUserScope({ models, userId: correction.userId, transaction });
    const allowed = await canResolve({ models, actor, correction, transaction });
    if (!allowed) {
      if (isSelf) throw correctionError('SELF_APPROVAL', 'You cannot resolve your own correction request.');
      throw correctionError('NOT_AUTHORIZED', 'You are not allowed to resolve this request.');
    }
    // Record the current role, not the caller's potentially stale instance.
    actor = await models.User.findByPk(actor.id, { transaction });
    // Claim the request: only one concurrent resolution can flip it.
    const [claimed] = await models.TimeCorrection.update(
      decision === 'reject'
        ? {
          status: STATUS.REJECTED,
          resolvedAt: serverNow,
          resolvedById: actor.id,
          rejectionReason,
        }
        : {
          status: STATUS.APPROVED,
          resolvedAt: serverNow,
          resolvedById: actor.id,
        },
      { where: { id: correction.id, status: STATUS.PENDING }, transaction }
    );

    if (claimed === 0) {
      throw correctionError('ALREADY_RESOLVED', 'This request has already been processed.');
    }

    const proposed = parseJson(correction.proposedValue);

    if (decision === 'reject') {
      await writeAuditRows({
        models, correction, actor, transaction,
        fromStatus: STATUS.PENDING, toStatus: STATUS.REJECTED, proposed,
      });
      const fresh = await models.TimeCorrection.findByPk(correction.id, { transaction });
      return { status: STATUS.REJECTED, correction: fresh, selfApproval: false };
    }

    const outcome = await applyCorrection({
      models, correction, actor, now: serverNow, transaction, selfApproval,
    });

    if (!outcome.applied) {
      // The decision was taken but the correction could not be applied: the
      // request is preserved with status 'conflict' and needs a human review.
      // The administrative self-approval is recorded even here: the decision
      // really happened.
      await models.TimeCorrection.update({
        status: STATUS.CONFLICT, conflictReason: outcome.conflict,
        selfApproved: selfApproval === true,
      }, { where: { id: correction.id }, transaction });

      await writeAuditRows({
        models, correction, actor, transaction,
        fromStatus: STATUS.PENDING, toStatus: STATUS.CONFLICT, proposed,
        selfApproval,
      });

      const fresh = await models.TimeCorrection.findByPk(correction.id, { transaction });
      return { status: STATUS.CONFLICT, conflict: outcome.conflict, correction: fresh, selfApproval };
    }

    // applyCorrection already wrote the 'applied' audit rows.
    const fresh = await models.TimeCorrection.findByPk(correction.id, { transaction });
    return { status: STATUS.APPLIED, correction: fresh, selfApproval };
  });
}

/** The requester withdraws a pending request. */
async function cancelRequest({ models, actor, correctionId, now }) {
  const serverNow = now || new Date();
  const id = parseInt(correctionId, 10);
  if (!Number.isInteger(id)) throw correctionError('NOT_FOUND', 'Unknown correction request.');

  const correction = await models.TimeCorrection.findOne({
    where: { id, companyId: actor.companyId },
  });
  if (!correction) throw correctionError('NOT_FOUND', 'Unknown correction request.');
  if (String(correction.userId) !== String(actor.id)) {
    throw correctionError('NOT_AUTHORIZED', 'You can only cancel your own requests.');
  }

  const [affected] = await models.TimeCorrection.update(
    {
      status: STATUS.CANCELLED,
      resolvedAt: serverNow,
      resolvedById: actor.id,
      rejectionReason: 'Cancelled by the requester',
    },
    { where: { id: correction.id, status: STATUS.PENDING } }
  );
  if (affected === 0) {
    throw correctionError('ALREADY_RESOLVED', 'This request has already been processed.');
  }

  return models.TimeCorrection.findByPk(correction.id);
}

// ---------------------------------------------------------------------------
// Listing and presentation
// ---------------------------------------------------------------------------

/** Requests submitted by the employee. */
async function listForUser({ models, user, limit }) {
  return models.TimeCorrection.findAll({
    where: { companyId: user.companyId, userId: user.id },
    order: [['created_at', 'DESC'], ['id', 'DESC']],
    limit: limit || 50,
  });
}

/**
 * Requests the actor is allowed to resolve: the pending ones of the employees
 * they supervise, or every pending one in the company for an owner/admin.
 */
async function listResolvable({ models, actor }) {
  const where = { companyId: actor.companyId, status: STATUS.PENDING };

  if (!can(actor, 'time.corrections.approve')) {
    const supervised = await actor.promise_supervised_users();
    const ids = supervised
      .filter((u) => String(u.companyId) === String(actor.companyId))
      .map((u) => u.id);
    if (!ids.length) return [];
    where.userId = { [Op.in]: ids };
  }

  return models.TimeCorrection.findAll({
    where,
    order: [['created_at', 'ASC'], ['id', 'ASC']],
  });
}

/** Pending requests of the employees the actor supervises (badge in the UI). */
async function countResolvable({ models, actor }) {
  const rows = await listResolvable({ models, actor });
  return rows.length;
}

/** Corrections attached to a set of sessions (single query), grouped by session. */
async function byEntryIds({ models, companyId, entryIds }) {
  if (!entryIds || !entryIds.length) return {};
  const rows = await models.TimeCorrection.findAll({
    where: { companyId, timeEntryId: entryIds },
    order: [['id', 'ASC']],
  });
  const map = {};
  rows.forEach((r) => {
    if (!map[r.timeEntryId]) map[r.timeEntryId] = [];
    map[r.timeEntryId].push(r);
  });
  return map;
}

/**
 * Turn a correction row into the strings the templates render.
 * Everything the employee declared is shown in the effective timezone.
 */
function presentCorrection(correction, { timezone, employeeName, canDecide, isOwn } = {}) {
  const zone = timezone || 'UTC';
  const proposed = parseJson(correction.proposedValue) || {};
  const original = parseJson(correction.originalValue);

  const describe = (value) => {
    if (!value) return '—';
    if (value.startedAt) {
      return `${localDateOf(value.startedAt, zone)} ${localTimeOf(value.startedAt, zone)}`;
    }
    if (value.endedAt) {
      return `${localDateOf(value.endedAt, zone)} ${localTimeOf(value.endedAt, zone)}`;
    }
    if (value.modality) return clockModule.modalityLabel(value.modality);
    if (value.type) return breaksModule.labelOf(value.type);
    if (value.date) return value.date;
    return JSON.stringify(value);
  };

  let originalLabel = '—';
  if (original) {
    if (original.startedAt) {
      originalLabel = `${localDateOf(original.startedAt, zone)} ${localTimeOf(original.startedAt, zone)}`;
    } else if (Object.prototype.hasOwnProperty.call(original, 'endedAt')) {
      originalLabel = original.endedAt
        ? `${localDateOf(original.endedAt, zone)} ${localTimeOf(original.endedAt, zone)}`
        : 'open (no clock-out recorded)';
    } else if (original.modality) {
      originalLabel = clockModule.modalityLabel(original.modality);
    } else if (original.type) {
      originalLabel = `${breaksModule.labelOf(original.type)}`
        + (original.countsAsWork ? ' (counted as worked time)' : ' (not counted as worked time)');
    }
  }

  let proposedLabel = '—';
  if (proposed.startedAt && proposed.endedAt && !proposed.type) {
    proposedLabel = `${localDateOf(proposed.startedAt, zone)} ${localTimeOf(proposed.startedAt, zone)}`
      + ` → ${localTimeOf(proposed.endedAt, zone)}`
      + (proposed.modality ? ` · ${clockModule.modalityLabel(proposed.modality)}` : '');
  } else if (proposed.startedAt && proposed.endedAt && proposed.type) {
    proposedLabel = `${localDateOf(proposed.startedAt, zone)} ${localTimeOf(proposed.startedAt, zone)}`
      + ` → ${localTimeOf(proposed.endedAt, zone)} · ${breaksModule.labelOf(proposed.type)}`;
  } else {
    proposedLabel = describe(proposed);
  }

  return {
    id: correction.id,
    type: correction.type,
    type_label: labelOfType(correction.type),
    status: correction.status,
    status_label: STATUS_LABELS[correction.status] || correction.status,
    policy: correction.policy,
    policy_label: MODE_LABELS[correction.policy] || correction.policy,
    original_label: originalLabel,
    proposed_label: proposedLabel,
    reason: correction.reason,
    rejection_reason: correction.rejectionReason,
    conflict_reason: correction.conflictReason,
    created_at: correction.createdAt ? localDateOf(correction.createdAt, zone) + ' ' + localTimeOf(correction.createdAt, zone) : null,
    resolved_at: correction.resolvedAt ? localDateOf(correction.resolvedAt, zone) + ' ' + localTimeOf(correction.resolvedAt, zone) : null,
    employee_name: employeeName || null,
    is_pending: correction.status === STATUS.PENDING,
    is_applied: correction.status === STATUS.APPLIED,
    is_conflict: correction.status === STATUS.CONFLICT,
    // The administrative self-approval: the request was approved by its own
    // requester, who held the administrative role of the company.
    is_self_approved: correction.selfApproved === true,
    is_self_approval_conflict: correction.selfApproved === true && correction.status === STATUS.CONFLICT,
    // Whether the acting user may take the decision on this request, and
    // whether the request belongs to them.
    can_decide: canDecide === true,
    is_own: isOwn === true,
  };
}

module.exports = {
  MODES,
  MODE_VALUES,
  DEFAULT_MODE,
  MODE_LABELS,
  TYPES,
  TYPE_VALUES,
  STATUS,
  STATUS_LABELS,
  getPolicy,
  setPolicy,
  createRequest,
  resolveRequest,
  cancelRequest,
  canResolve,
  isSupervisorOf,
  listForUser,
  listResolvable,
  countResolvable,
  byEntryIds,
  presentCorrection,
  instantFromLocal,
  localDateOf,
  localTimeOf,
  labelOfType,
};
