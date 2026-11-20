'use strict';

/*
 * Serialisation helper for work-session mutations.
 *
 * Starting a break and closing the session both read state that the other one
 * changes (is there an active break? is the session still open?). Without a shared
 * lock, two concurrent requests can interleave: the clock-out sees "no active
 * break", a break starts and commits, and the clock-out then closes the session,
 * leaving a closed session with an active break that the normal flow can no longer
 * finish.
 *
 * Taking the lock on the PARENT time_entries row serialises both operations:
 *   - PostgreSQL: SELECT ... FOR UPDATE, which conflicts with the FOR KEY SHARE
 *     lock an INSERT into time_breaks takes for its foreign key, so the break
 *     insert cannot slip between the check and the update;
 *   - SQLite: a no-op UPDATE takes the database write lock for the rest of the
 *     transaction (SQLite serialises writers), which has the same effect.
 *
 * Callers must lock BEFORE reading the state they depend on, and read it after.
 */

/** Lock the work session row (and serialise its breaks) inside a transaction. */
async function lockTimeEntry({ models, entryId, transaction }) {
  const sequelize = models.sequelize || models.TimeEntry.sequelize;

  if (sequelize.getDialect() === 'postgres') {
    await models.TimeEntry.findByPk(entryId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    return;
  }

  // SQLite: no row-level locking, so take the write lock explicitly. The statement
  // changes nothing; it exists to acquire the lock inside this transaction.
  await sequelize.query('UPDATE time_entries SET status = status WHERE id = ?', {
    replacements: [entryId],
    transaction,
  });
}

/**
 * Lock everything that belongs to one employee.
 *
 * Shared by clocking and correction flows, including declarations without an
 * existing session. Acquire this before taking any individual session lock.
 * PostgreSQL uses a dedicated advisory-lock namespace keyed by employee ID;
 * SQLite serializes writers with a no-op update to the employee row.
 */
async function lockUserScope({ models, userId, transaction }) {
  const sequelize = models.sequelize || models.User.sequelize;

  if (sequelize.getDialect() === 'postgres') {
    // A transaction advisory lock avoids upgrading the FK KEY SHARE locks
    // acquired by inserts into an exclusive lock on Users.
    await sequelize.query('SELECT pg_advisory_xact_lock(?, ?)', {
      replacements: [1414090053, Number(userId)], transaction,
    });
    return;
  }

  await sequelize.query('UPDATE "Users" SET "email" = "email" WHERE "id" = ?', {
    replacements: [userId],
    transaction,
  });
}

module.exports = { lockTimeEntry, lockUserScope };
