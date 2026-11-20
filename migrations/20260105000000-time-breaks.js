'use strict';

/*
 * Time-tracking block 2: breaks and break policy.
 *
 * Additive and reversible: two new tables, no existing table altered, no data
 * touched. Safe on a clean test database and on a database with block-1 rows.
 *
 * ALL DDL RUNS IN ONE TRANSACTION. Both PostgreSQL and SQLite support transactional
 * DDL, so a failure in the middle (for example while creating the second index)
 * rolls the whole migration back and it can be re-run cleanly. Without this, a
 * partial schema was left behind and the retry failed with
 * "index ... already exists", requiring manual recovery.
 *
 * break_policies — per company, per break type: whether the break counts as
 *   worked time. Absent row = the initial explicit default (does not count).
 *
 * time_breaks — one row per break. `counts_as_work` is a SNAPSHOT of the policy
 *   at the moment the break started, which is what keeps historical entries
 *   stable: changing the company policy later cannot retroactively change how an
 *   already recorded break is counted.
 *
 * Integrity (database level, PostgreSQL + SQLite):
 *   - one ACTIVE break per work session: partial UNIQUE index on
 *     time_breaks(time_entry_id) WHERE ended_at IS NULL. Two concurrent
 *     "start break" requests cannot both succeed.
 *   - break end after break start: CHECK on PostgreSQL (SQLite cannot add a CHECK
 *     to an existing table; the service check covers both engines).
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable('break_policies', {
        id: { type: Sequelize.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
        company_id: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: 'Companies', key: 'id' },
        },
        type: { type: Sequelize.STRING(16), allowNull: false },
        counts_as_work: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        created_at: { type: Sequelize.DATE, allowNull: false },
        updated_at: { type: Sequelize.DATE, allowNull: false },
      }, { transaction });

      await queryInterface.addIndex(
        'break_policies',
        ['company_id', 'type'],
        { unique: true, name: 'break_policies_company_type_unique', transaction }
      );

      await queryInterface.createTable('time_breaks', {
        id: { type: Sequelize.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
        company_id: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: 'Companies', key: 'id' },
        },
        user_id: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: 'Users', key: 'id' },
        },
        time_entry_id: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: 'time_entries', key: 'id' },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
        },
        type: { type: Sequelize.STRING(16), allowNull: false },
        // Snapshot of the policy when the break started (never recomputed).
        counts_as_work: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        started_at: { type: Sequelize.DATE, allowNull: false },
        ended_at: { type: Sequelize.DATE, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false },
        updated_at: { type: Sequelize.DATE, allowNull: false },
      }, { transaction });

      await queryInterface.addIndex('time_breaks', ['company_id'], { transaction });
      await queryInterface.addIndex('time_breaks', ['time_entry_id'], { transaction });
      await queryInterface.addIndex('time_breaks', ['user_id', 'started_at'], { transaction });

      await queryInterface.sequelize.query(
        'CREATE UNIQUE INDEX time_breaks_one_active_per_entry ' +
        'ON time_breaks (time_entry_id) WHERE ended_at IS NULL',
        { transaction }
      );

      if (queryInterface.sequelize.getDialect() === 'postgres') {
        await queryInterface.sequelize.query(
          'ALTER TABLE time_breaks ADD CONSTRAINT time_breaks_ended_after_started ' +
          'CHECK (ended_at IS NULL OR ended_at > started_at)',
          { transaction }
        );
      }
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable('time_breaks', { transaction });
      await queryInterface.dropTable('break_policies', { transaction });
    });
  },
};