'use strict';

/*
 * Work-time incidents (block 4).
 *
 * PRINCIPLE: AN INCIDENT COMMUNICATES, IT NEVER CORRECTS.
 *
 * Block 3 answers "I clocked in at 09:30, it should be 09:00": that is a
 * correction, and it changes the effective record through an approved request.
 * This module answers "the clocking system was down and I need to explain what
 * happened": it records the situation, the conversation and the answer, and it
 * NEVER touches a clock time, a break, the computation or an absence balance.
 *
 * The employee never blocks on the workflow: filing an incident is immediate and
 * needs no approval. What needs authorization is the DECISION: taking the
 * incident into review, resolving it or dismissing it.
 *
 * AUTHORISATION IS DECIDED HERE, NOT IN THE VIEWS:
 *   - the creator always sees their own incident;
 *   - a real supervisor of the employee (Department.boss or DepartmentSupervisor,
 *     read at request time, so a department change or a revoked link takes
 *     effect immediately) decides on it;
 *   - an owner/admin (permission 'time.incidents.manage') decides on every
 *     incident of the company, and may also decide on their OWN one, as an
 *     explicit administrative self-resolution (recorded in the audit trail).
 *   The RBAC role 'manager' alone gives nothing: it is not a supervision link.
 *
 * APPEND-ONLY HISTORY: the visible thread (time_incident_entries) is only ever
 * INSERTed, and every action also writes a row to the `audit` table
 * (entity_type = 'TIME_INCIDENT'). Nothing updates an old entry.
 *
 * CONCURRENCY is proportional and explicit: every mutation takes the incident
 * row lock inside its transaction and then uses a conditional UPDATE on the
 * expected status. Two resolutions cannot both win, and a comment racing a
 * resolution either commits before it (and is read by it) or is refused once the
 * incident is closed: it can never land after the closing.
 */

const { Op } = require('sequelize');

const { can, roleOf } = require('../../auth/permissions');
const corrections = require('./corrections');
const schedule = require('./schedule');
const clockModule = require('./clock');

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Initial taxonomy. It is deliberately CLOSED: a company cannot invent hundreds
 * of types, and no medical or health category is introduced. The free text lives
 * in `description`.
 */
const TYPES = [
  {
    value: 'clocking_problem',
    label: 'Clocking system problem',
    hint: 'The clock-in/clock-out platform was unreachable, failed, or a punch was not recorded.',
  },
  {
    value: 'work_interruption',
    label: 'Work interruption',
    hint: 'A power cut, an IT incident or an operational problem stopped the work for a while.',
  },
  {
    value: 'schedule_discrepancy',
    label: 'Schedule or computation discrepancy',
    hint: 'The expected schedule was wrong, or the computed hours do not look right to you.',
  },
  {
    value: 'exceptional_circumstance',
    label: 'Exceptional circumstance',
    hint: 'Something unusual happened during the working day and it should be on record.',
  },
  {
    value: 'other',
    label: 'Other',
    hint: 'Any other work-time situation that needs a human answer.',
  },
];
const TYPE_VALUES = TYPES.map((t) => t.value);

const STATUS = {
  OPEN: 'open',
  IN_REVIEW: 'in_review',
  RESOLVED: 'resolved',
  DISMISSED: 'dismissed',
};
const STATUS_VALUES = [STATUS.OPEN, STATUS.IN_REVIEW, STATUS.RESOLVED, STATUS.DISMISSED];
const FINAL_STATUSES = [STATUS.RESOLVED, STATUS.DISMISSED];

const STATUS_LABELS = {
  open: 'Open',
  in_review: 'In review',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
};

/**
 * Allowed transitions. There is no reopening and no escalation in this block:
 * `resolved` and `dismissed` are terminal.
 */
const TRANSITIONS = {
  open: [STATUS.IN_REVIEW, STATUS.RESOLVED, STATUS.DISMISSED],
  in_review: [STATUS.RESOLVED, STATUS.DISMISSED],
  resolved: [],
  dismissed: [],
};

const ENTRY_KIND = {
  COMMENT: 'comment',
  IN_REVIEW: 'in_review',
  RESOLVED: 'resolved',
  DISMISSED: 'dismissed',
  LINK: 'link',
};

const ENTRY_KIND_LABELS = {
  comment: 'Message',
  in_review: 'Taken into review',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
  link: 'Correction linked',
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;

const LIMITS = {
  TITLE: 200,
  DESCRIPTION: 5000,
  MESSAGE: 4000,
};

// Filters offered in the lists. Kept short on purpose.
const FILTERS = [
  { value: '', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'in_review', label: 'In review' },
  { value: 'closed', label: 'Closed' },
];

function incidentError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function isUniqueViolation(err) {
  if (!err) return false;
  if (err.name === 'SequelizeUniqueConstraintError') return true;
  return /unique constraint|SQLITE_CONSTRAINT/i.test(String(err.message || ''));
}

/**
 * A concurrent writer can make the second submission wait for the first one
 * (SQLite has a single writer and PG can time out): the double click must not
 * surface as an error when the incident it wanted already exists.
 */
function isLockContention(err) {
  if (!err) return false;
  if (err.name === 'SequelizeTimeoutError') return true;
  return /SQLITE_BUSY|database is locked|deadlock detected|lock timeout/i
    .test(String(err.message || ''));
}

function truncate(value, max) {
  if (value === null || value === undefined) return null;
  return String(value).slice(0, max || 255);
}

function labelOfType(type) {
  const found = TYPES.find((t) => t.value === type);
  return found ? found.label : type;
}

function isFinal(status) {
  return FINAL_STATUSES.includes(status);
}

function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

/** Split a comma/space separated id list into integers, ignoring the noise. */
function parseId(value) {
  const id = parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Where clause of a list filter. */
function statusWhere(filter) {
  if (filter === 'closed') {
    return { [Op.in]: FINAL_STATUSES };
  }
  if (filter && STATUS_VALUES.includes(filter) && !isFinal(filter)) {
    return filter;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Validation of the employee input (server side, always)
// ---------------------------------------------------------------------------

function cleanText(value, { code, tooLongCode, max, label }) {
  const text = String(value === null || value === undefined ? '' : value).trim();
  if (!text) throw incidentError(code, label + ' is required.');
  if (text.length > max) throw incidentError(tooLongCode, label + ' is too long.');
  return text;
}

function cleanDate(value, { now, timezone }) {
  const date = String(value || '').trim();
  if (!DATE_RE.test(date)) {
    throw incidentError('INVALID_DATE', 'The reference date is not a valid date.');
  }
  // Reject impossible civil dates (2026-02-31) that a regex would accept.
  const parsed = new Date(date + 'T00:00:00Z');
  if (isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw incidentError('INVALID_DATE', 'The reference date is not a valid date.');
  }
  const today = schedule.formatDateInZone(now || new Date(), timezone || 'UTC');
  if (date > today) {
    throw incidentError('FUTURE_DATE', 'The reference date cannot be in the future.');
  }
  return date;
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

/**
 * Serialise every mutation of one incident.
 *
 * PostgreSQL: SELECT ... FOR UPDATE on the incident row. SQLite: a no-op UPDATE
 * takes the database write lock for the rest of the transaction (blocks 1-3 use
 * the same technique).
 *
 * Callers must lock BEFORE reading the state they depend on, and read it after.
 */
async function lockIncident({ models, incidentId, transaction }) {
  const sequelize = models.sequelize;
  const id = parseId(incidentId);
  if (!id) return null;

  if (sequelize.getDialect() === 'postgres') {
    return models.TimeIncident.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  }

  await sequelize.query('UPDATE time_incidents SET status = status WHERE id = ?', {
    replacements: [id], transaction,
  });
  return models.TimeIncident.findByPk(id, { transaction });
}

/**
 * Re-read the ACTOR inside the transaction, and hold its row.
 *
 * Authorisation must never be decided on an instance loaded before the
 * transaction: a role revoked in between (an admin who is no longer an admin,
 * a supervision link removed, an employee who changed department) would still
 * be honoured. PostgreSQL takes `SELECT ... FOR UPDATE` on the user row, so a
 * concurrent revocation waits; SQLite takes the write lock with a no-op UPDATE,
 * which serialises writers the same way.
 *
 * The caller must use the returned instance for every authorisation decision
 * and for the recorded resolver/author, so the audit trail names the role the
 * person really had at that instant.
 */
async function lockActor({ models, actorId, transaction }) {
  const sequelize = models.sequelize;
  const id = parseId(actorId);
  if (!id) return null;

  if (sequelize.getDialect() === 'postgres') {
    return models.User.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  }

  await sequelize.query('UPDATE "Users" SET "email" = "email" WHERE "id" = ?', {
    replacements: [id], transaction,
  });
  return models.User.findByPk(id, { transaction });
}

// ---------------------------------------------------------------------------
// Authorisation
// ---------------------------------------------------------------------------

/** The administrative capacity of the company (owner/admin). */
function isAdministrator(actor) {
  return can(actor, 'time.incidents.manage');
}

/**
 * May the actor read this incident?
 *
 * - the creator;
 * - anybody holding the administrative capacity of the company;
 * - a real supervisor of the employee (boss of the department or a
 *   DepartmentSupervisor link), evaluated against the CURRENT department.
 */
async function canView({ models, actor, incident, transaction }) {
  if (!incident || !actor) return false;
  if (String(incident.companyId) !== String(actor.companyId)) return false;
  if (String(incident.userId) === String(actor.id)) return true;
  if (isAdministrator(actor)) return true;

  const employee = await models.User.findByPk(incident.userId, { transaction });
  if (!employee) return false;
  return corrections.isSupervisorOf({ models, actor, employee, transaction });
}

/**
 * May the actor DECIDE on this incident (review, resolve, dismiss)?
 *
 * The requester may decide on their own incident only as the explicit
 * administrative exception (owner/admin). A department boss, a
 * DepartmentSupervisor or an RBAC 'manager' can never decide on their own.
 */
async function canManage({ models, actor, incident, transaction }) {
  if (!incident || !actor) return false;
  if (String(incident.companyId) !== String(actor.companyId)) return false;

  if (String(incident.userId) === String(actor.id)) {
    return isAdministrator(actor);
  }

  if (isAdministrator(actor)) return true;

  const employee = await models.User.findByPk(incident.userId, { transaction });
  if (!employee) return false;
  return corrections.isSupervisorOf({ models, actor, employee, transaction });
}

/** The employees the actor supervises, inside the actor's company. */
async function supervisedUserIds({ models, actor }) {
  const supervised = await actor.promise_supervised_users();
  return supervised
    .filter((u) => String(u.companyId) === String(actor.companyId))
    .map((u) => u.id);
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * Write the audit rows of one action.
 *
 * The administrative self-resolution gets its OWN row, so it can never be
 * confused with a normal decision: the attribute name says it and the value
 * carries who did it and which role they held.
 */
async function writeAuditRows({ models, incident, actor, transaction, rows }) {
  for (const row of rows) {
    await models.Audit.create({
      companyId: incident.companyId,
      byUserId: actor.id,
      entityType: 'TIME_INCIDENT',
      entityId: incident.id,
      attribute: row.attribute,
      oldValue: truncate(row.oldValue, 255),
      newValue: truncate(row.newValue, 255),
    }, { transaction });
  }
}

function selfResolutionRow({ incident, actor }) {
  return {
    attribute: 'administrative_self_resolution',
    oldValue: null,
    newValue: JSON.stringify({
      selfResolved: true,
      resolvedById: actor.id,
      role: roleOf(actor),
      status: incident.status,
    }),
  };
}

// ---------------------------------------------------------------------------
// The activity thread
// ---------------------------------------------------------------------------

/**
 * Append one entry. APPEND-ONLY: there is no update and no delete anywhere.
 * Runs inside the caller's transaction, after the incident lock was taken.
 */
async function appendEntry({
  models, incident, actor, transaction, kind, body, fromStatus, toStatus, at,
}) {
  const instant = at || new Date();
  const entry = await models.TimeIncidentEntry.create({
    companyId: incident.companyId,
    incidentId: incident.id,
    authorId: actor.id,
    kind,
    body: truncate(body, 8000),
    fromStatus: fromStatus || null,
    toStatus: toStatus || null,
    at: instant,
  }, { transaction });

  await models.TimeIncident.update(
    { lastActivityAt: instant },
    { where: { id: incident.id }, transaction }
  );

  return entry;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Load one incident of the actor's company (tenant scope is mandatory). */
async function loadIncident({ models, actor, incidentId, transaction }) {
  const id = parseId(incidentId);
  if (!id) throw incidentError('INCIDENT_NOT_FOUND', 'Unknown incident.');
  const incident = await models.TimeIncident.findOne({
    where: { id, companyId: actor.companyId },
    transaction,
  });
  if (!incident) throw incidentError('INCIDENT_NOT_FOUND', 'Unknown incident.');
  return incident;
}

/**
 * Load an incident the actor is allowed to READ. A record of another company
 * and a record of somebody else's scope produce the same answer: it does not
 * exist for this actor.
 */
async function getForActor({ models, actor, incidentId }) {
  const incident = await loadIncident({ models, actor, incidentId });
  const allowed = await canView({ models, actor, incident });
  if (!allowed) throw incidentError('INCIDENT_NOT_FOUND', 'Unknown incident.');
  return incident;
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/**
 * Create an incident.
 *
 * `timeEntryId` is looked up with companyId + userId = the acting user, so a
 * tampered identifier simply does not exist: an employee can never attach an
 * incident to somebody else's session, nor to another company's.
 *
 * A double submission is not an error: `idempotencyKey` (a token rendered in the
 * form) is unique per employee, so the second insert returns the incident that
 * already exists.
 */
async function createIncident({ models, actor, input, timezone, now }) {
  const data = input || {};
  const serverNow = now || new Date();
  const zone = timezone || 'UTC';
  const sequelize = models.sequelize;

  const type = String(data.type || '').trim();
  if (!TYPE_VALUES.includes(type)) {
    throw incidentError('INVALID_TYPE', 'Choose a valid incident type.');
  }

  const title = cleanText(data.title, {
    code: 'TITLE_REQUIRED', tooLongCode: 'TITLE_TOO_LONG', max: LIMITS.TITLE, label: 'The title',
  });
  const description = cleanText(data.description, {
    code: 'DESCRIPTION_REQUIRED', tooLongCode: 'DESCRIPTION_TOO_LONG',
    max: LIMITS.DESCRIPTION, label: 'The description',
  });
  const localDate = cleanDate(data.local_date || data.date, { now: serverNow, timezone: zone });

  const token = String(data.idempotency_key || '').trim();
  const idempotencyKey = TOKEN_RE.test(token) ? token : null;

  const entryId = parseId(data.time_entry_id || data.target_entry);

  try {
    return await sequelize.transaction(async (transaction) => {
      // The optional session must be the actor's own one.
      let entry = null;
      if (entryId) {
        entry = await models.TimeEntry.findOne({
          where: { id: entryId, companyId: actor.companyId, userId: actor.id },
          transaction,
        });
        if (!entry) {
          throw incidentError('ENTRY_NOT_FOUND', 'That work session does not exist.');
        }
      }

      const incident = await models.TimeIncident.create({
        companyId: actor.companyId,
        userId: actor.id,
        timeEntryId: entry ? entry.id : null,
        timeCorrectionId: null,
        localDate,
        type,
        title,
        description,
        status: STATUS.OPEN,
        idempotencyKey,
        openedAt: serverNow,
        reviewStartedAt: null,
        resolvedAt: null,
        resolvedById: null,
        resolution: null,
        selfResolved: false,
        lastActivityAt: serverNow,
      }, { transaction });

      await writeAuditRows({
        models, incident, actor, transaction,
        rows: [
          { attribute: 'status', oldValue: null, newValue: STATUS.OPEN },
          { attribute: 'type', oldValue: null, newValue: type },
          { attribute: 'title', oldValue: null, newValue: title },
          { attribute: 'local_date', oldValue: null, newValue: localDate },
          { attribute: 'description', oldValue: null, newValue: description },
          {
            attribute: 'time_entry_id',
            oldValue: null,
            newValue: entry ? String(entry.id) : null,
          },
        ],
      });

      return { incident, created: true };
    });
  } catch (err) {
    // Double submission: the same client token cannot create a second incident.
    if (idempotencyKey && (isUniqueViolation(err) || isLockContention(err))) {
      const existing = await models.TimeIncident.findOne({
        where: { userId: actor.id, idempotencyKey },
      });
      if (existing) return { incident: existing, created: false };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Activity: a clarification or an answer
// ---------------------------------------------------------------------------

/**
 * Add a message to the thread.
 *
 * Never changes the status by itself. Refused once the incident is closed: a
 * message can never land after the closing, even under concurrency, because the
 * status is read under the row lock inside the same transaction.
 */
async function addComment({ models, actor, incidentId, body, now }) {
  const text = cleanText(body, {
    code: 'COMMENT_REQUIRED', tooLongCode: 'COMMENT_TOO_LONG',
    max: LIMITS.MESSAGE, label: 'The message',
  });

  const sequelize = models.sequelize;
  return sequelize.transaction(async (transaction) => {
    const incident = await lockIncident({ models, incidentId, transaction });
    if (!incident || String(incident.companyId) !== String(actor.companyId)) {
      throw incidentError('INCIDENT_NOT_FOUND', 'Unknown incident.');
    }

    // The instant is fixed only once the row is ours: anything captured before
    // waiting for the lock could be older than an entry committed meanwhile.
    const at = now || new Date();

    const freshActor = (await lockActor({ models, actorId: actor.id, transaction })) || actor;
    const allowed = await canView({ models, actor: freshActor, incident, transaction });
    if (!allowed) throw incidentError('INCIDENT_NOT_FOUND', 'Unknown incident.');

    if (isFinal(incident.status)) {
      throw incidentError('INCIDENT_CLOSED', 'This incident is closed: no more messages can be added.');
    }

    const entry = await appendEntry({
      models, incident, actor: freshActor, transaction,
      kind: ENTRY_KIND.COMMENT,
      body: text,
      at,
    });

    await writeAuditRows({
      models, incident, actor: freshActor, transaction,
      rows: [{
        attribute: 'activity',
        oldValue: null,
        newValue: JSON.stringify({
          kind: ENTRY_KIND.COMMENT, entryId: entry.id, length: text.length,
        }),
      }],
    });

    return { incident, entry };
  });
}

// ---------------------------------------------------------------------------
// Workflow: review, resolve, dismiss
// ---------------------------------------------------------------------------

/**
 * Shared preamble of every decision: lock the incident, re-read and lock the
 * actor, authorise with the FRESH actor.
 *
 * Returns `{ incident, actor }`. Callers must use the returned actor for the
 * resolver and for the audit rows: the instance the caller passed in may be
 * stale (a revoked admin, a removed supervision link), and the decision has to
 * be evaluated against the database, not against the object it received.
 */
async function prepareDecision({ models, actor, incidentId, transaction }) {
  const incident = await lockIncident({ models, incidentId, transaction });
  if (!incident || String(incident.companyId) !== String(actor.companyId)) {
    throw incidentError('INCIDENT_NOT_FOUND', 'Unknown incident.');
  }

  const freshActor = (await lockActor({ models, actorId: actor.id, transaction })) || actor;

  const allowed = await canManage({ models, actor: freshActor, incident, transaction });
  if (!allowed) {
    throw incidentError('NOT_AUTHORIZED', 'You are not allowed to decide on this incident.');
  }

  return { incident, actor: freshActor };
}

/** open -> in_review. A responsible person has taken it. */
async function startReview({ models, actor, incidentId, now }) {
  const sequelize = models.sequelize;

  return sequelize.transaction(async (transaction) => {
    const decided = await prepareDecision({ models, actor, incidentId, transaction });
    const incident = decided.incident;
    const freshActor = decided.actor;
    const at = now || new Date();

    if (!canTransition(incident.status, STATUS.IN_REVIEW)) {
      if (isFinal(incident.status)) {
        throw incidentError('ALREADY_CLOSED', 'This incident is already closed.');
      }
      throw incidentError('INVALID_TRANSITION', 'This incident is already in review.');
    }

    const [updated] = await models.TimeIncident.update(
      { status: STATUS.IN_REVIEW, reviewStartedAt: at, lastActivityAt: at },
      {
        where: { id: incident.id, status: STATUS.OPEN },
        transaction,
      }
    );
    if (updated === 0) {
      throw incidentError('ALREADY_CLOSED', 'This incident has already been processed.');
    }

    await appendEntry({
      models, incident, actor: freshActor, transaction,
      kind: ENTRY_KIND.IN_REVIEW,
      body: 'The incident was taken into review.',
      fromStatus: STATUS.OPEN,
      toStatus: STATUS.IN_REVIEW,
      at,
    });

    await writeAuditRows({
      models, incident, actor: freshActor, transaction,
      rows: [
        { attribute: 'status', oldValue: STATUS.OPEN, newValue: STATUS.IN_REVIEW },
        { attribute: 'review_started_at', oldValue: null, newValue: at.toISOString() },
      ],
    });

    return models.TimeIncident.findByPk(incident.id, { transaction });
  });
}

/**
 * Resolve the incident with an answer the employee can read.
 *
 * `open -> resolved` and `in_review -> resolved`. The administrative
 * self-resolution (owner/admin acting on their own incident) sets
 * `selfResolved` and writes its own audit row.
 */
async function resolveIncident({ models, actor, incidentId, response, now }) {
  const text = cleanText(response, {
    code: 'RESPONSE_REQUIRED', tooLongCode: 'RESPONSE_TOO_LONG',
    max: LIMITS.MESSAGE, label: 'The answer',
  });

  const sequelize = models.sequelize;
  return sequelize.transaction(async (transaction) => {
    const decided = await prepareDecision({ models, actor, incidentId, transaction });
    const incident = decided.incident;
    const freshActor = decided.actor;
    // Fixed after the lock: never older than an entry committed meanwhile.
    const at = now || new Date();

    if (!canTransition(incident.status, STATUS.RESOLVED)) {
      throw incidentError('ALREADY_CLOSED', 'This incident has already been processed.');
    }

    const selfResolved = String(incident.userId) === String(freshActor.id);

    const [updated] = await models.TimeIncident.update({
      status: STATUS.RESOLVED,
      resolvedAt: at,
      resolvedById: freshActor.id,
      resolution: text,
      selfResolved,
      lastActivityAt: at,
    }, {
      where: { id: incident.id, status: { [Op.in]: [STATUS.OPEN, STATUS.IN_REVIEW] } },
      transaction,
    });
    if (updated === 0) {
      throw incidentError('ALREADY_CLOSED', 'This incident has already been processed.');
    }

    await appendEntry({
      models, incident, actor: freshActor, transaction,
      kind: ENTRY_KIND.RESOLVED,
      body: text,
      fromStatus: incident.status,
      toStatus: STATUS.RESOLVED,
      at,
    });

    const rows = [
      { attribute: 'status', oldValue: incident.status, newValue: STATUS.RESOLVED },
      { attribute: 'resolution', oldValue: null, newValue: text },
      { attribute: 'resolved_by', oldValue: null, newValue: String(freshActor.id) },
    ];
    if (selfResolved) {
      rows.push(selfResolutionRow({ incident: { status: STATUS.RESOLVED }, actor: freshActor }));
    }

    await writeAuditRows({ models, incident, actor: freshActor, transaction, rows });

    return models.TimeIncident.findByPk(incident.id, { transaction });
  });
}

/**
 * Dismiss the incident with a reason.
 *
 * `open -> dismissed` and `in_review -> dismissed`. A dismissal always carries a
 * justification: closing something without explanation is not acceptable.
 */
async function dismissIncident({ models, actor, incidentId, reason, now }) {
  const text = cleanText(reason, {
    code: 'RESPONSE_REQUIRED', tooLongCode: 'RESPONSE_TOO_LONG',
    max: LIMITS.MESSAGE, label: 'The reason for the dismissal',
  });

  const sequelize = models.sequelize;
  return sequelize.transaction(async (transaction) => {
    const decided = await prepareDecision({ models, actor, incidentId, transaction });
    const incident = decided.incident;
    const freshActor = decided.actor;
    const at = now || new Date();

    if (!canTransition(incident.status, STATUS.DISMISSED)) {
      throw incidentError('ALREADY_CLOSED', 'This incident has already been processed.');
    }

    const selfResolved = String(incident.userId) === String(freshActor.id);

    const [updated] = await models.TimeIncident.update({
      status: STATUS.DISMISSED,
      resolvedAt: at,
      resolvedById: freshActor.id,
      resolution: text,
      selfResolved,
      lastActivityAt: at,
    }, {
      where: { id: incident.id, status: { [Op.in]: [STATUS.OPEN, STATUS.IN_REVIEW] } },
      transaction,
    });
    if (updated === 0) {
      throw incidentError('ALREADY_CLOSED', 'This incident has already been processed.');
    }

    await appendEntry({
      models, incident, actor: freshActor, transaction,
      kind: ENTRY_KIND.DISMISSED,
      body: text,
      fromStatus: incident.status,
      toStatus: STATUS.DISMISSED,
      at,
    });

    const rows = [
      { attribute: 'status', oldValue: incident.status, newValue: STATUS.DISMISSED },
      { attribute: 'resolution', oldValue: null, newValue: text },
      { attribute: 'resolved_by', oldValue: null, newValue: String(freshActor.id) },
    ];
    if (selfResolved) {
      rows.push(selfResolutionRow({ incident: { status: STATUS.DISMISSED }, actor: freshActor }));
    }

    await writeAuditRows({ models, incident, actor: freshActor, transaction, rows });

    return models.TimeIncident.findByPk(incident.id, { transaction });
  });
}

// ---------------------------------------------------------------------------
// Relation with block 3 (corrections)
// ---------------------------------------------------------------------------

/**
 * Attach an existing correction request of the same employee to the incident.
 *
 * The link is ONLY a pointer: nothing is approved, nothing is applied and the
 * computation does not change. A correction in conflict never resolves the
 * incident by itself (there is no such automatic behaviour anywhere).
 *
 * Only the creator can link, and only while the incident is not closed: the
 * reference is part of the story the employee is telling.
 */
async function linkCorrection({ models, actor, incidentId, correctionId, now }) {
  const sequelize = models.sequelize;
  const targetId = parseId(correctionId);
  if (!targetId) throw incidentError('CORRECTION_NOT_FOUND', 'Unknown correction request.');

  return sequelize.transaction(async (transaction) => {
    const incident = await lockIncident({ models, incidentId, transaction });
    if (!incident || String(incident.companyId) !== String(actor.companyId)) {
      throw incidentError('INCIDENT_NOT_FOUND', 'Unknown incident.');
    }
    const at = now || new Date();
    const freshActor = (await lockActor({ models, actorId: actor.id, transaction })) || actor;

    if (String(incident.userId) !== String(freshActor.id)) {
      throw incidentError('NOT_AUTHORIZED', 'Only the requester can link a correction.');
    }
    if (isFinal(incident.status)) {
      throw incidentError('INCIDENT_CLOSED', 'This incident is closed: it cannot be linked.');
    }

    // Same employee AND same company: no cross-company and no cross-employee
    // reference is possible, even with a manipulated identifier.
    const correction = await models.TimeCorrection.findOne({
      where: {
        id: targetId,
        companyId: incident.companyId,
        userId: incident.userId,
      },
      transaction,
    });
    if (!correction) {
      throw incidentError('CORRECTION_NOT_FOUND', 'Unknown correction request.');
    }

    if (String(incident.timeCorrectionId || '') === String(correction.id)) {
      // Idempotent: linking the same correction twice is not an error.
      return incident;
    }

    const [updated] = await models.TimeIncident.update(
      { timeCorrectionId: correction.id, lastActivityAt: at },
      { where: { id: incident.id, status: { [Op.in]: [STATUS.OPEN, STATUS.IN_REVIEW] } }, transaction }
    );
    if (updated === 0) {
      throw incidentError('INCIDENT_CLOSED', 'This incident is closed: it cannot be linked.');
    }

    await appendEntry({
      models, incident, actor: freshActor, transaction,
      kind: ENTRY_KIND.LINK,
      body: 'Correction request #' + correction.id + ' was linked to this incident.',
      at,
    });

    await writeAuditRows({
      models, incident, actor: freshActor, transaction,
      rows: [{
        attribute: 'time_correction_id',
        oldValue: incident.timeCorrectionId ? String(incident.timeCorrectionId) : null,
        newValue: String(correction.id),
      }],
    });

    return models.TimeIncident.findByPk(incident.id, { transaction });
  });
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/** The incidents of the employee, newest first. */
async function listForUser({ models, user, filter, limit }) {
  const where = { companyId: user.companyId, userId: user.id };
  const status = statusWhere(filter);
  if (status) where.status = status;

  return models.TimeIncident.findAll({
    where,
    order: [['opened_at', 'DESC'], ['id', 'DESC']],
    limit: limit || 100,
  });
}

/**
 * The WHERE clause of the incidents the actor is allowed to supervise.
 * `null` means "the actor has no supervision scope at all".
 *
 * It is a real scope, not a UI filter: an owner/admin gets the whole company, a
 * supervisor gets the employees they supervise, and a plain employee gets
 * nothing.
 */
async function queueScope({ models, actor }) {
  const where = { companyId: actor.companyId };

  if (!isAdministrator(actor)) {
    const ids = await supervisedUserIds({ models, actor });
    if (!ids.length) return null;
    where.userId = { [Op.in]: ids };
  }

  return where;
}

/** Does the actor have anything to supervise (or the administrative capacity)? */
async function hasQueueScope({ models, actor }) {
  const where = await queueScope({ models, actor });
  return where !== null;
}

/**
 * The incidents the actor may decide on or supervise: every incident of the
 * company for an owner/admin, the incidents of the supervised employees for a
 * supervisor, and nothing at all for a plain employee.
 *
 * Pending incidents come FIRST, so an old backlog of closed cases can never push
 * a case that still needs a decision out of the page.
 */
async function listQueue({ models, actor, filter, limit }) {
  const where = await queueScope({ models, actor });
  if (!where) return [];

  const status = statusWhere(filter);
  if (status) where.status = status;

  const closed = filter === 'closed';
  const order = closed
    ? [['resolved_at', 'DESC'], ['id', 'DESC']]
    : [
      // Pending first, whatever the status filter is: the tray is a work queue.
      [
        models.sequelize.literal("CASE WHEN status IN ('open', 'in_review') THEN 0 ELSE 1 END"),
        'ASC',
      ],
      ['opened_at', 'ASC'],
      ['id', 'ASC'],
    ];

  return models.TimeIncident.findAll({
    where,
    order,
    limit: limit || 100,
  });
}

/**
 * How many incidents are waiting for a decision in the actor's scope.
 *
 * This is a COUNT over the whole authorised scope, never the length of a page:
 * a backlog of closed cases must not be able to hide a pending one, nor to hide
 * the entry to the tray.
 */
async function countPending({ models, actor }) {
  const where = await queueScope({ models, actor });
  if (!where) return 0;

  return models.TimeIncident.count({
    where: Object.assign({}, where, {
      status: { [Op.in]: [STATUS.OPEN, STATUS.IN_REVIEW] },
    }),
  });
}

/**
 * The corrections an employee can link to an incident: their own ones, newest
 * first. It never exposes another employee's request.
 */
async function linkableCorrections({ models, user, limit }) {
  return models.TimeCorrection.findAll({
    where: { companyId: user.companyId, userId: user.id },
    order: [['created_at', 'DESC'], ['id', 'DESC']],
    limit: limit || 20,
  });
}

/** The thread of one incident, in chronological order. */
async function listEntries({ models, companyId, incidentId }) {
  return models.TimeIncidentEntry.findAll({
    where: { companyId, incidentId },
    order: [['at', 'ASC'], ['id', 'ASC']],
  });
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

function localDateTime(value, timezone) {
  if (!value) return null;
  return schedule.formatDateInZone(value, timezone) + ' ' + schedule.formatTimeInZone(value, timezone);
}

/**
 * Turn an incident row into the strings the templates render.
 * Everything is escaped by Handlebars: this function never returns HTML.
 */
function presentIncident(incident, {
  timezone, employeeName, resolverName, canManage: mayDecide, isOwn, timeEntry, correction,
} = {}) {
  const zone = timezone || 'UTC';
  const status = incident.status;

  return {
    id: incident.id,
    type: incident.type,
    type_label: labelOfType(incident.type),
    title: incident.title,
    description: incident.description,
    status,
    status_label: STATUS_LABELS[status] || status,
    local_date: incident.localDate,
    opened_at: localDateTime(incident.openedAt, zone),
    review_started_at: localDateTime(incident.reviewStartedAt, zone),
    resolved_at: localDateTime(incident.resolvedAt, zone),
    last_activity_at: localDateTime(incident.lastActivityAt, zone),
    resolution: incident.resolution,
    self_resolved: incident.selfResolved === true,
    is_open: status === STATUS.OPEN,
    is_in_review: status === STATUS.IN_REVIEW,
    is_resolved: status === STATUS.RESOLVED,
    is_dismissed: status === STATUS.DISMISSED,
    is_final: isFinal(status),
    is_open_for_activity: !isFinal(status),
    employee_name: employeeName || null,
    resolver_name: resolverName || null,
    can_manage: mayDecide === true,
    is_own: isOwn === true,
    // Optional related work session (block 1).
    has_entry: !!incident.timeEntryId,
    entry_date: timeEntry ? timeEntry.date : null,
    entry_started_at: timeEntry ? timeEntry.started_at : null,
    entry_ended_at: timeEntry ? timeEntry.ended_at : null,
    entry_is_open: timeEntry ? timeEntry.is_open === true : false,
    entry_modality_label: timeEntry ? timeEntry.modality_label : null,
    // Optional related correction (block 3). It is a reference, never an action.
    has_correction: !!incident.timeCorrectionId,
    correction_id: correction ? correction.id : (incident.timeCorrectionId || null),
    correction_label: correction ? correction.label : null,
    correction_status: correction ? correction.status : null,
    correction_status_label: correction ? correction.status_label : null,
    correction_url: incident.timeCorrectionId
      ? '/time/corrections/#' + incident.timeCorrectionId
      : null,
  };
}

/** Turn one thread entry into the strings the templates render. */
function presentEntry(entry, { timezone, authorName, isManagerNote } = {}) {
  const zone = timezone || 'UTC';
  return {
    id: entry.id,
    kind: entry.kind,
    kind_label: ENTRY_KIND_LABELS[entry.kind] || entry.kind,
    body: entry.body,
    from_status_label: entry.fromStatus ? (STATUS_LABELS[entry.fromStatus] || entry.fromStatus) : null,
    to_status_label: entry.toStatus ? (STATUS_LABELS[entry.toStatus] || entry.toStatus) : null,
    at: localDateTime(entry.at, zone),
    author_name: authorName || null,
    is_manager_note: isManagerNote === true,
  };
}

/** Label of a correction for the link selector. */
function correctionLabel(correction, timezone) {
  const zone = timezone || 'UTC';
  const date = correction.createdAt
    ? schedule.formatDateInZone(correction.createdAt, zone)
    : '';
  return '#' + correction.id + ' · ' + corrections.labelOfType(correction.type)
    + ' · ' + corrections.STATUS_LABELS[correction.status]
    + (date ? ' · ' + date : '');
}

module.exports = {
  TYPES,
  TYPE_VALUES,
  STATUS,
  STATUS_VALUES,
  STATUS_LABELS,
  FINAL_STATUSES,
  TRANSITIONS,
  ENTRY_KIND,
  ENTRY_KIND_LABELS,
  FILTERS,
  LIMITS,
  labelOfType,
  isFinal,
  canTransition,
  canView,
  canManage,
  isAdministrator,
  supervisedUserIds,
  createIncident,
  addComment,
  startReview,
  resolveIncident,
  dismissIncident,
  linkCorrection,
  getForActor,
  listForUser,
  listQueue,
  queueScope,
  hasQueueScope,
  countPending,
  linkableCorrections,
  listEntries,
  presentIncident,
  presentEntry,
  correctionLabel,
  cleanDate,
  // Re-exported so the routes do not need to require two modules.
  MODALITIES: clockModule.MODALITIES,
};