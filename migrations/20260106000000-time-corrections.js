'use strict';

/*
 * Time-tracking block 3: corrections and approvals.
 *
 * Additive and reversible: two new tables plus four new columns on existing
 * time tables. No existing row is rewritten, so block-1/block-2 data is
 * preserved untouched.
 *
 * ALL DDL RUNS IN ONE TRANSACTION. Both PostgreSQL and SQLite support
 * transactional DDL, so a failure in the middle rolls the whole migration back
 * and it can be re-run cleanly (same guarantee as the block-2 migration).
 *
 * time_correction_policies — one row per company: how corrections are resolved.
 *   'self_service'       -> the employee's correction is applied immediately.
 *   'approval_required'  -> a supervisor has to approve it first.
 *   Absent row = the explicit initial default ('approval_required', the prudent
 *   choice requested by the product).
 *
 * time_corrections — one row per correction REQUEST, never per applied change.
 * The request keeps the original value, the proposed value, the reason, the
 * policy that was in force when it was submitted, and who resolved it and when.
 * The effective record is NEVER silently overwritten: applying a correction
 * appends a 'correction' event to the session timeline and leaves the original
 * 'in' / 'out' / 'break_start' / 'break_end' events untouched.
 *
 * Integrity (database level, PostgreSQL + SQLite):
 *   - one PENDING request per target and employee: partial UNIQUE index on
 *     time_corrections(user_id, target_key) WHERE status = 'pending'. Two
 *     conflicting requests for the same field cannot both wait for approval.
 *   - allowed status / type / policy values: CHECK constraints on PostgreSQL
 *     (SQLite cannot ALTER ADD CHECK; the service validates on both engines).
 *   - the correction history is never lost with the employee: the FK to Users
 *     is NO ACTION, and User.remove refuses before deleting anything.
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const dialect = queryInterface.sequelize.getDialect();

    await queryInterface.sequelize.transaction(async (transaction) => {
      // ---------------------------------------------------------------------
      // 1. Company policy: how corrections are resolved.
      // ---------------------------------------------------------------------
      await queryInterface.createTable('time_correction_policies', {
        id: { type: Sequelize.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
        company_id: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: 'Companies', key: 'id' },
        },
        mode: { type: Sequelize.STRING(24), allowNull: false, defaultValue: 'approval_required' },
        created_at: { type: Sequelize.DATE, allowNull: false },
        updated_at: { type: Sequelize.DATE, allowNull: false },
      }, { transaction });

      await queryInterface.addIndex(
        'time_correction_policies',
        ['company_id'],
        { unique: true, name: 'time_correction_policies_company_unique', transaction }
      );

      // ---------------------------------------------------------------------
      // 2. Correction requests.
      // ---------------------------------------------------------------------
      await queryInterface.createTable('time_corrections', {
        id: { type: Sequelize.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
        company_id: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: 'Companies', key: 'id' },
        },
        // The employee who asked for the correction.
        user_id: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: 'Users', key: 'id' },
        },
        // Affected session (NULL while a forgotten session is still only a request).
        time_entry_id: {
          type: Sequelize.INTEGER, allowNull: true,
          references: { model: 'time_entries', key: 'id' },
        },
        // Affected break, when the correction targets a break.
        time_break_id: {
          type: Sequelize.INTEGER, allowNull: true,
          references: { model: 'time_breaks', key: 'id' },
        },
        type: { type: Sequelize.STRING(24), allowNull: false },
        status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'pending' },
        // Stable identifier of WHAT is being corrected ("entry:12:start", ...).
        // Used by the partial unique index to block two pending requests for the
        // same target.
        target_key: { type: Sequelize.STRING(80), allowNull: false },
        // Snapshot of the value before the correction (JSON). NULL when there was
        // no previous value (a forgotten session).
        original_value: { type: Sequelize.TEXT, allowNull: true },
        // Snapshot of the proposed value (JSON).
        proposed_value: { type: Sequelize.TEXT, allowNull: false },
        reason: { type: Sequelize.TEXT, allowNull: false },
        // The policy that applied WHEN the request was submitted. Changing the
        // company policy later never reclassifies an existing request.
        policy: { type: Sequelize.STRING(24), allowNull: false },
        // Version of the session when the request was created (informative).
        entry_version: { type: Sequelize.INTEGER, allowNull: true },
        resolved_at: { type: Sequelize.DATE, allowNull: true },
        resolved_by_id: {
          type: Sequelize.INTEGER, allowNull: true,
          references: { model: 'Users', key: 'id' },
        },
        rejection_reason: { type: Sequelize.TEXT, allowNull: true },
        // Why the request could not be applied (it stays pending for review).
        conflict_reason: { type: Sequelize.TEXT, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false },
        updated_at: { type: Sequelize.DATE, allowNull: false },
      }, { transaction });

      await queryInterface.addIndex('time_corrections', ['company_id'], { transaction });
      await queryInterface.addIndex('time_corrections', ['user_id', 'created_at'], { transaction });
      await queryInterface.addIndex('time_corrections', ['status', 'company_id'], { transaction });
      await queryInterface.addIndex('time_corrections', ['time_entry_id'], { transaction });
      await queryInterface.addIndex('time_corrections', ['time_break_id'], { transaction });

      // One pending request per target and employee.
      await queryInterface.sequelize.query(
        'CREATE UNIQUE INDEX time_corrections_one_pending_per_target ' +
        'ON time_corrections (user_id, target_key) WHERE status = \'pending\'',
        { transaction }
      );

      // ---------------------------------------------------------------------
      // 3. Session provenance and version.
      // ---------------------------------------------------------------------
      // 'direct'   -> the employee clocked in/out.
      // 'declared' -> the session was declared afterwards through a correction.
      await queryInterface.addColumn(
        'time_entries',
        'source',
        { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'direct' },
        { transaction }
      );

      // Incremented on every change of the effective session values. It is
      // informative; the conflict detection uses the value snapshot compared
      // inside the transaction (proportional mechanism, no version history).
      await queryInterface.addColumn(
        'time_entries',
        'version',
        { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
        { transaction }
      );

      // ---------------------------------------------------------------------
      // 4. Correction events on the session timeline.
      // ---------------------------------------------------------------------
      await queryInterface.addColumn(
        'time_entry_events',
        'correction_id',
        { type: Sequelize.INTEGER, allowNull: true },
        { transaction }
      );

      // JSON payload of a correction event (what changed, from -> to, origin).
      await queryInterface.addColumn(
        'time_entry_events',
        'payload',
        { type: Sequelize.TEXT, allowNull: true },
        { transaction }
      );

      await queryInterface.addIndex('time_entry_events', ['correction_id'], { transaction });

      // ---------------------------------------------------------------------
      // 5. Value constraints (PostgreSQL only; SQLite validates in the service).
      // ---------------------------------------------------------------------
      if (dialect === 'postgres') {
        await queryInterface.sequelize.query(
          'ALTER TABLE time_corrections ADD CONSTRAINT time_corrections_type_check ' +
          'CHECK (type IN (\'entry_start\', \'entry_end\', \'missing_entry\', ' +
          '\'break_start\', \'break_end\', \'break_type\', \'break_missing\', \'modality\'))',
          { transaction }
        );
        await queryInterface.sequelize.query(
          'ALTER TABLE time_corrections ADD CONSTRAINT time_corrections_status_check ' +
          'CHECK (status IN (\'pending\', \'approved\', \'rejected\', \'applied\', \'conflict\', \'cancelled\'))',
          { transaction }
        );
        await queryInterface.sequelize.query(
          'ALTER TABLE time_corrections ADD CONSTRAINT time_corrections_policy_check ' +
          'CHECK (policy IN (\'self_service\', \'approval_required\'))',
          { transaction }
        );
        await queryInterface.sequelize.query(
          'ALTER TABLE time_correction_policies ADD CONSTRAINT time_correction_policies_mode_check ' +
          'CHECK (mode IN (\'self_service\', \'approval_required\'))',
          { transaction }
        );
        await queryInterface.sequelize.query(
          'ALTER TABLE time_entries ADD CONSTRAINT time_entries_source_check ' +
          'CHECK (source IN (\'direct\', \'declared\'))',
          { transaction }
        );
        await queryInterface.sequelize.query(
          'ALTER TABLE time_entry_events ADD CONSTRAINT time_entry_events_type_check ' +
          'CHECK (type IN (\'in\', \'out\', \'break_start\', \'break_end\', \'correction\'))',
          { transaction }
        );
        await queryInterface.sequelize.query(
          'ALTER TABLE time_entry_events ADD CONSTRAINT time_entry_events_source_check ' +
          'CHECK (source IN (\'direct\', \'declared\', \'auto\', \'corrected\'))',
          { transaction }
        );
        // Explicit reference from the event to the request that caused it.
        await queryInterface.sequelize.query(
          'ALTER TABLE time_entry_events ADD CONSTRAINT time_entry_events_correction_fk ' +
          'FOREIGN KEY (correction_id) REFERENCES time_corrections (id) ' +
          'ON DELETE SET NULL ON UPDATE CASCADE',
          { transaction }
        );
      }
    });
  },

  down: async (queryInterface) => {
    const dialect = queryInterface.sequelize.getDialect();

    await queryInterface.sequelize.transaction(async (transaction) => {
      // Rolling this block back would otherwise erase requests and provenance.
      // Leave the whole schema untouched when there is correction history.
      await queryInterface.sequelize.query(
        dialect === 'postgres'
          ? 'LOCK TABLE time_corrections IN ACCESS EXCLUSIVE MODE'
          : 'UPDATE time_corrections SET status = status WHERE 0',
        { transaction }
      );
      const [history] = await queryInterface.sequelize.query(
        'SELECT COUNT(*) AS count FROM time_corrections', { transaction }
      );
      if (Number(history[0].count) > 0) {
        throw new Error('Cannot roll back time corrections while correction history exists');
      }
      if (dialect === 'postgres') {
        await queryInterface.sequelize.query(
          'ALTER TABLE time_entry_events DROP CONSTRAINT IF EXISTS time_entry_events_correction_fk',
          { transaction }
        );
        await queryInterface.sequelize.query(
          'ALTER TABLE time_entry_events DROP CONSTRAINT IF EXISTS time_entry_events_type_check, ' +
          'DROP CONSTRAINT IF EXISTS time_entry_events_source_check', { transaction }
        );
      }

      if (dialect === 'sqlite') {
        // Native DROP COLUMN preserves the table and its incoming foreign keys.
        await queryInterface.sequelize.query('DROP INDEX IF EXISTS time_entry_events_correction_id', { transaction });
        for (const [table, column] of [['time_entry_events', 'payload'], ['time_entry_events', 'correction_id'], ['time_entries', 'version'], ['time_entries', 'source']]) {
          await queryInterface.sequelize.query(`ALTER TABLE "${table}" DROP COLUMN "${column}"`, { transaction });
        }
      } else {
        await queryInterface.removeColumn('time_entry_events', 'payload', { transaction });
        await queryInterface.removeColumn('time_entry_events', 'correction_id', { transaction });
        await queryInterface.removeColumn('time_entries', 'version', { transaction });
        await queryInterface.removeColumn('time_entries', 'source', { transaction });
      }

      await queryInterface.dropTable('time_corrections', { transaction });
      await queryInterface.dropTable('time_correction_policies', { transaction });

      // SQLite rebuilds the table when a column is removed, which drops the
      // partial index created by the block-1 migration. Recreate it.
      if (dialect === 'sqlite') {
        await queryInterface.sequelize.query(
          "CREATE UNIQUE INDEX IF NOT EXISTS time_entries_one_open_per_user " +
          "ON time_entries (user_id) WHERE status = 'open'",
          { transaction }
        );
      }
    });
  },
};
