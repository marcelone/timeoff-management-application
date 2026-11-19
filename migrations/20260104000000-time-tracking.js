'use strict';

/*
 * Time-tracking module — block 1: basic work-session recording.
 *
 * Additive only: three new tables, no existing table is altered and no data is
 * touched. Safe to run on a clean test database.
 *
 * Integrity enforced at the database level (not only in application code):
 *   - one OPEN session per user: partial UNIQUE index on time_entries(user_id)
 *     WHERE status = 'open'. Supported by both PostgreSQL and SQLite (>=3.8),
 *     so concurrent/duplicate clock-ins cannot create two open rows even if two
 *     requests race past the application check.
 *   - clock-out after clock-in: CHECK constraint. SQLite cannot add a CHECK to an
 *     existing table, so it is created on PostgreSQL only; the service check in
 *     lib/modules/time/clock.js enforces the same rule on both engines.
 *   - time entries are never deleted with the employee implicitly: the FK is
 *     NO ACTION, so removing a user with recorded sessions fails instead of
 *     losing the clock history (see User.remove, which checks this first).
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('time_entries', {
      id: { type: Sequelize.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
      company_id: {
        type: Sequelize.INTEGER, allowNull: false,
        references: { model: 'Companies', key: 'id' },
      },
      user_id: {
        type: Sequelize.INTEGER, allowNull: false,
        references: { model: 'Users', key: 'id' },
      },
      modality: { type: Sequelize.STRING(16), allowNull: false },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'open' },
      started_at: { type: Sequelize.DATE, allowNull: false },
      ended_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('time_entries', ['company_id']);
    await queryInterface.addIndex('time_entries', ['user_id', 'status']);

    await queryInterface.createTable('time_entry_events', {
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
      occurred_at: { type: Sequelize.DATE, allowNull: false },
      source: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'direct' },
      modality: { type: Sequelize.STRING(16), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('time_entry_events', ['company_id']);
    await queryInterface.addIndex('time_entry_events', ['time_entry_id']);
    await queryInterface.addIndex('time_entry_events', ['user_id', 'occurred_at']);

    await queryInterface.createTable('work_schedule_days', {
      id: { type: Sequelize.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
      company_id: {
        type: Sequelize.INTEGER, allowNull: false,
        references: { model: 'Companies', key: 'id' },
      },
      scope_type: { type: Sequelize.STRING(16), allowNull: false },
      scope_id: { type: Sequelize.INTEGER, allowNull: false },
      weekday: { type: Sequelize.INTEGER, allowNull: false },
      // true = working day with hours; false = explicit non-working day (stops inheritance).
      is_working_day: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      start_time: { type: Sequelize.STRING(5), allowNull: true },
      end_time: { type: Sequelize.STRING(5), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('work_schedule_days', ['company_id']);
    await queryInterface.addIndex(
      'work_schedule_days',
      ['company_id', 'scope_type', 'scope_id', 'weekday'],
      { unique: true, name: 'work_schedule_days_scope_weekday_unique' }
    );

    // One open session per user (PostgreSQL + SQLite partial index).
    await queryInterface.sequelize.query(
      "CREATE UNIQUE INDEX time_entries_one_open_per_user ON time_entries (user_id) WHERE status = 'open'"
    );

    // Clock-out strictly after clock-in (PostgreSQL only; SQLite cannot ALTER ADD CHECK).
    if (queryInterface.sequelize.getDialect() === 'postgres') {
      await queryInterface.sequelize.query(
        'ALTER TABLE time_entries ADD CONSTRAINT time_entries_ended_after_started ' +
        'CHECK (ended_at IS NULL OR ended_at > started_at)'
      );
    }
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('work_schedule_days');
    await queryInterface.dropTable('time_entry_events');
    await queryInterface.dropTable('time_entries');
  },
};