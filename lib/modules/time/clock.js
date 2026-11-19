'use strict';

/*
 * Clock service — starting and stopping a work session.
 *
 * All instants come from the server (`now` defaults to the server clock) and are
 * stored as UTC. The browser never supplies a time.
 *
 * Concurrency: "one open session per user" is enforced by a partial unique index
 * in the database, so two simultaneous clock-ins cannot both succeed. The
 * application check only produces a friendly message on the common path; the
 * unique-violation catch is what makes it correct under a race. Clock-out is a
 * conditional UPDATE (WHERE status='open'), so a second/parallel stop cannot
 * close the row twice or move the end time.
 *
 * These functions never accept a target user: the caller passes the authenticated
 * user, so a request cannot clock in/out for somebody else by tampering params.
 */

const MODALITIES = [
  { value: 'office', label: 'Office' },
  { value: 'remote', label: 'Remote' },
  { value: 'travel', label: 'Travel' },
];
const MODALITY_VALUES = MODALITIES.map((m) => m.value);

function clockError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function modalityLabel(value) {
  const found = MODALITIES.find((m) => m.value === value);
  return found ? found.label : value;
}

function isUniqueViolation(err) {
  if (!err) return false;
  if (err.name === 'SequelizeUniqueConstraintError') return true;
  // SQLite surfaces the partial index violation as a generic error.
  return /unique constraint|SQLITE_CONSTRAINT/i.test(String(err.message || ''));
}

function nowUtc() {
  return new Date();
}

async function findOpenEntry({ models, user }) {
  return models.TimeEntry.findOne({
    where: { companyId: user.companyId, userId: user.id, status: 'open' },
    order: [['id', 'DESC']],
  });
}

async function startEntry({ models, user, modality, now /* default: server clock */ }) {
  if (!MODALITY_VALUES.includes(modality)) {
    throw clockError('INVALID_MODALITY', 'Unknown work modality');
  }

  const startedAt = now || nowUtc();

  // Friendly path: report the already-open session instead of failing on the index.
  const existing = await findOpenEntry({ models, user });
  if (existing) {
    throw clockError('ALREADY_OPEN', 'There is already an open work session');
  }

  const sequelize = models.TimeEntry.sequelize;

  try {
    return await sequelize.transaction(async (transaction) => {
      const entry = await models.TimeEntry.create({
        companyId: user.companyId,
        userId: user.id,
        modality,
        status: 'open',
        startedAt,
        endedAt: null,
      }, { transaction });

      await models.TimeEntryEvent.create({
        companyId: user.companyId,
        userId: user.id,
        timeEntryId: entry.id,
        type: 'in',
        occurredAt: entry.startedAt,
        source: 'direct',
        modality,
      }, { transaction });

      return entry;
    });
  } catch (err) {
    // Race: another request opened the session between the check and the insert.
    if (isUniqueViolation(err)) {
      throw clockError('ALREADY_OPEN', 'There is already an open work session');
    }
    throw err;
  }
}

async function stopEntry({ models, user, now /* default: server clock */ }) {
  const endedAt = now || nowUtc();
  const sequelize = models.TimeEntry.sequelize;

  return sequelize.transaction(async (transaction) => {
    const open = await models.TimeEntry.findOne({
      where: { companyId: user.companyId, userId: user.id, status: 'open' },
      order: [['id', 'DESC']],
      transaction,
    });

    if (!open) {
      throw clockError('NOT_OPEN', 'There is no open work session to finish');
    }

    // The PostgreSQL CHECK constraint cannot be added on SQLite, and Sequelize
    // validations do not run on a bulk `update`, so the invariant is enforced
    // here against the loaded row (a clock that moved backwards must not close
    // a session before it started).
    if (new Date(endedAt).getTime() <= new Date(open.startedAt).getTime()) {
      throw clockError('INVALID_END', 'The end time cannot be before the start time');
    }

    // Conditional update: only one concurrent stop can flip the row.
    const [affected] = await models.TimeEntry.update(
      { status: 'closed', endedAt },
      { where: { id: open.id, status: 'open' }, transaction }
    );

    if (affected === 0) {
      throw clockError('NOT_OPEN', 'There is no open work session to finish');
    }

    await models.TimeEntryEvent.create({
      companyId: user.companyId,
      userId: user.id,
      timeEntryId: open.id,
      type: 'out',
      occurredAt: endedAt,
      source: 'direct',
      modality: open.modality,
    }, { transaction });

    return models.TimeEntry.findByPk(open.id, { transaction });
  });
}

async function listRecentEntries({ models, user, limit = 10 }) {
  return models.TimeEntry.findAll({
    where: { companyId: user.companyId, userId: user.id },
    order: [['started_at', 'DESC'], ['id', 'DESC']],
    limit,
  });
}

module.exports = {
  MODALITIES,
  MODALITY_VALUES,
  modalityLabel,
  nowUtc,
  findOpenEntry,
  startEntry,
  stopEntry,
  listRecentEntries,
};