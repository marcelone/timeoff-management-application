'use strict';

/*
 * Break service — starting/stopping breaks and reading/writing the company policy.
 *
 * Rules enforced here (and, where the engine allows, in the database):
 *   - a break needs an open work session;
 *   - only one active break per session (partial unique index as the real guard);
 *   - a break cannot start before the session started, nor end after it ended;
 *   - only server time is used (never a client-supplied timestamp);
 *   - starting a break snapshots the company policy onto the break row, so later
 *     policy changes never rewrite history;
 *   - every mutation runs in a transaction together with its event row.
 */

const BREAK_TYPES = [
  { value: 'regular', label: 'Regular rest' },
  { value: 'personal', label: 'Personal break' },
  { value: 'justified', label: 'Justified break' },
];
const BREAK_TYPE_VALUES = BREAK_TYPES.map((t) => t.value);

// Explicit initial default: none of the three types counts as worked time.
const DEFAULT_POLICY = { regular: false, personal: false, justified: false };

const { lockTimeEntry } = require('./locks');

function breakError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function isUniqueViolation(err) {
  if (!err) return false;
  if (err.name === 'SequelizeUniqueConstraintError') return true;
  return /unique constraint|SQLITE_CONSTRAINT/i.test(String(err.message || ''));
}

function labelOf(type) {
  const found = BREAK_TYPES.find((t) => t.value === type);
  return found ? found.label : type;
}

/** Company policy as a plain map, defaults filled in. */
async function getPolicy(models, companyId, transaction) {
  const rows = await models.BreakPolicy.findAll({ where: { companyId }, transaction });
  const policy = Object.assign({}, DEFAULT_POLICY);
  rows.forEach((r) => { policy[r.type] = r.countsAsWork === true; });
  return policy;
}

/** Persist the policy (one row per type; upsert-like, transaction-safe). */
async function setPolicy(models, companyId, incoming) {
  const sequelize = models.sequelize || models.BreakPolicy.sequelize;

  return sequelize.transaction(async (transaction) => {
    // A policy is saved as a whole. Without a shared lock, two concurrent
    // requests can each skip unchanged rows and commit a mixture of both forms.
    if (sequelize.getDialect() === 'postgres') {
      await models.Company.findByPk(companyId, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
    } else {
      // SQLite has no row locks; acquire its write lock before reading policy.
      await sequelize.query('UPDATE "Companies" SET "name" = "name" WHERE "id" = ?', {
        replacements: [companyId],
        transaction,
      });
    }

    for (const type of BREAK_TYPE_VALUES) {
      if (!(type in incoming)) continue;
      const counts = incoming[type] === true || incoming[type] === 'true' || incoming[type] === 'on';
      const existing = await models.BreakPolicy.findOne({
        where: { companyId, type }, transaction,
      });
      if (existing) {
        existing.countsAsWork = counts;
        await existing.save({ transaction });
      } else {
        await models.BreakPolicy.create(
          { companyId, type, countsAsWork: counts },
          { transaction }
        );
      }
    }
    return getPolicy(models, companyId, transaction);
  });
}

async function findOpenEntry(models, user, transaction) {
  return models.TimeEntry.findOne({
    where: { companyId: user.companyId, userId: user.id, status: 'open' },
    order: [['id', 'DESC']],
    transaction,
  });
}

async function findActiveBreak(models, user, transaction) {
  return models.TimeBreak.findOne({
    where: { companyId: user.companyId, userId: user.id, endedAt: null },
    order: [['id', 'DESC']],
    transaction,
  });
}

async function startBreak({ models, user, type, now }) {
  if (!BREAK_TYPE_VALUES.includes(type)) {
    throw breakError('INVALID_TYPE', 'Unknown break type');
  }
  const startedAt = now || new Date();
  const sequelize = models.sequelize || models.TimeBreak.sequelize;

  try {
    return await sequelize.transaction(async (transaction) => {
      const entry = await findOpenEntry(models, user, transaction);
      if (!entry) {
        throw breakError('NO_OPEN_ENTRY', 'There is no open work session');
      }

      // Serialise against a concurrent clock-out before reading the state below.
      await lockTimeEntry({ models, entryId: entry.id, transaction });

      // Re-read after taking the lock: the session may have been closed meanwhile.
      const fresh = await models.TimeEntry.findByPk(entry.id, { transaction });
      if (!fresh || fresh.status !== 'open' || fresh.endedAt) {
        throw breakError('NO_OPEN_ENTRY', 'There is no open work session');
      }

      if (new Date(startedAt).getTime() <= new Date(fresh.startedAt).getTime()) {
        throw breakError('BEFORE_ENTRY', 'A break cannot start before the work session');
      }

      const active = await findActiveBreak(models, user, transaction);
      if (active) {
        throw breakError('ALREADY_ACTIVE', 'A break is already active');
      }

      // A break cannot start before the end of the previous one. Checked under the
      // lock so a request that captured an earlier "now" cannot land out of order
      // and produce overlapping breaks (which would deduct the same time twice).
      const priorBreaks = await models.TimeBreak.findAll({
        where: { timeEntryId: entry.id }, transaction,
      });
      const lastEnd = priorBreaks.reduce((latest, b) => {
        if (!b.endedAt) return latest;
        const t = new Date(b.endedAt).getTime();
        return latest === null || t > latest ? t : latest;
      }, null);
      if (lastEnd !== null && new Date(startedAt).getTime() < lastEnd) {
        throw breakError('OVERLAPS_PREVIOUS', 'A break cannot start before the previous break ends');
      }

      // Snapshot the policy that applies right now.
      const policy = await getPolicy(models, user.companyId, transaction);
      const countsAsWork = policy[type] === true;

      const brk = await models.TimeBreak.create({
        companyId: user.companyId,
        userId: user.id,
        timeEntryId: entry.id,
        type,
        countsAsWork,
        startedAt,
        endedAt: null,
      }, { transaction });

      await models.TimeEntryEvent.create({
        companyId: user.companyId,
        userId: user.id,
        timeEntryId: entry.id,
        type: 'break_start',
        occurredAt: startedAt,
        source: 'direct',
        modality: entry.modality,
      }, { transaction });

      return brk;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw breakError('ALREADY_ACTIVE', 'A break is already active');
    }
    throw err;
  }
}

async function stopBreak({ models, user, now }) {
  const endedAt = now || new Date();
  const sequelize = models.sequelize || models.TimeBreak.sequelize;

  return sequelize.transaction(async (transaction) => {
    const open = await findActiveBreak(models, user, transaction);
    if (!open) {
      throw breakError('NO_ACTIVE_BREAK', 'There is no active break to finish');
    }

    // Same lock as the clock-out: a break cannot be closed while the session is
    // being closed, and the session cannot be closed while this break is active.
    await lockTimeEntry({ models, entryId: open.timeEntryId, transaction });

    if (new Date(endedAt).getTime() <= new Date(open.startedAt).getTime()) {
      throw breakError('INVALID_END', 'The break end cannot be before its start');
    }

    const entry = await models.TimeEntry.findByPk(open.timeEntryId, { transaction });
    if (!entry) {
      throw breakError('NO_ACTIVE_BREAK', 'There is no active break to finish');
    }
    // A break belongs inside its session: it cannot outlive the clock-out.
    if (entry.endedAt && new Date(endedAt).getTime() > new Date(entry.endedAt).getTime()) {
      throw breakError('AFTER_ENTRY', 'A break cannot end after the work session');
    }

    const [affected] = await models.TimeBreak.update(
      { endedAt },
      { where: { id: open.id, endedAt: null }, transaction }
    );
    if (affected === 0) {
      throw breakError('NO_ACTIVE_BREAK', 'There is no active break to finish');
    }

    await models.TimeEntryEvent.create({
      companyId: user.companyId,
      userId: user.id,
      timeEntryId: entry.id,
      type: 'break_end',
      occurredAt: endedAt,
      source: 'direct',
      modality: entry.modality,
    }, { transaction });

    return models.TimeBreak.findByPk(open.id, { transaction });
  });
}

/** Breaks of a set of sessions, grouped by session id (single query). */
async function breaksByEntryIds({ models, companyId, entryIds }) {
  if (!entryIds.length) return {};
  const rows = await models.TimeBreak.findAll({
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

module.exports = {
  BREAK_TYPES,
  BREAK_TYPE_VALUES,
  DEFAULT_POLICY,
  labelOf,
  getPolicy,
  setPolicy,
  findActiveBreak,
  breaksByEntryIds,
  startBreak,
  stopBreak,
};
