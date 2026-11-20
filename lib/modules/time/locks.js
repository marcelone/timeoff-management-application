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

module.exports = { lockTimeEntry };