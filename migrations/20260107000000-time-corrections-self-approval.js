'use strict';

/*
 * Time-tracking block 3 (adjustment): administrative self-approval.
 *
 * Adds ONE column to time_corrections: `self_approved`.
 *
 *   false -> the request was decided by somebody other than its requester, or
 *            it is still pending, or it was rejected / cancelled.
 *   true  -> the request was APPROVED by its own requester, who held the
 *            administrative role of the company (owner/admin). It is an explicit
 *            administrative exception, never a supervisor decision.
 *
 * Additive and reversible: no existing row is rewritten. The requests that
 * were already resolved keep `self_approved = false` and keep exactly the
 * meaning they had, and the requests that are still pending can be resolved
 * with the new rule.
 *
 * ALL DDL RUNS IN ONE TRANSACTION (same guarantee as the other block-3 DDL):
 * a failure in the middle rolls the whole migration back.
 *
 * Integrity (PostgreSQL):
 *   - CHECK (NOT self_approved OR status IN ('applied', 'conflict')): a request
 *     can only carry the administrative self-approval flag when a decision was
 *     really taken on it. A pending or a rejected request can NEVER carry it.
 *   (SQLite cannot ALTER ADD CHECK; the service validates on both engines.)
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const dialect = queryInterface.sequelize.getDialect();

    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn(
        'time_corrections',
        'self_approved',
        { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        { transaction }
      );

      if (dialect === 'postgres') {
        await queryInterface.sequelize.query(
          'ALTER TABLE time_corrections ADD CONSTRAINT time_corrections_self_approval_check ' +
          'CHECK (NOT self_approved OR status IN (\'applied\', \'conflict\'))',
          { transaction }
        );
      }
    });
  },

  down: async (queryInterface) => {
    const dialect = queryInterface.sequelize.getDialect();

    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        dialect === 'postgres'
          ? 'LOCK TABLE time_corrections IN ACCESS EXCLUSIVE MODE'
          : 'UPDATE time_corrections SET status = status WHERE 0',
        { transaction }
      );
      const [history] = await queryInterface.sequelize.query(
        'SELECT COUNT(*) AS count FROM time_corrections WHERE self_approved = true', { transaction }
      );
      if (Number(history[0].count) > 0) {
        throw new Error('Cannot roll back self-approval while administrative self-approval history exists');
      }
      if (dialect === 'postgres') {
        await queryInterface.sequelize.query(
          'ALTER TABLE time_corrections DROP CONSTRAINT IF EXISTS time_corrections_self_approval_check',
          { transaction }
        );
      }

      await queryInterface.removeColumn('time_corrections', 'self_approved', { transaction });

      // SQLite rebuilds the table when a column is removed, which drops the
      // partial unique index created by the block-3 migration. Recreate it.
      if (dialect === 'sqlite') {
        await queryInterface.sequelize.query(
          'CREATE UNIQUE INDEX IF NOT EXISTS time_corrections_one_pending_per_target ' +
          'ON time_corrections (user_id, target_key) WHERE status = \'pending\'',
          { transaction }
        );
      }
    });
  },
};
