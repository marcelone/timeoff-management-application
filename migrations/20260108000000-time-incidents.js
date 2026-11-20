'use strict';

/*
 * Time-tracking block 4: work-time incidents and employee self-service.
 *
 * An INCIDENT is a communication, not a correction. It never changes a clock
 * time, a break or the computation: it records what happened, who is looking at
 * it and what was answered. Correcting a recorded time stays in block 3
 * (`time_corrections`); an incident may simply REFERENCE an existing correction.
 *
 * Two new tables, additive and reversible. No existing row is rewritten, so
 * blocks 1-3 keep their data untouched.
 *
 * time_incidents — one row per incident.
 *   status: 'open' -> 'in_review' -> 'resolved' | 'dismissed'
 *   `time_entry_id` and `time_correction_id` are OPTIONAL references: an
 *   incident can exist with no work session at all, and one session can have
 *   several incidents.
 *   `self_resolved` marks the administrative self-resolution (an owner/admin
 *   resolving their own incident), exactly like block 3 does for corrections.
 *   `last_activity_at` is maintained on every activity so block 5 can detect
 *   "new answer", "state changed" and "pending for too long" without a
 *   scheduler or an outbox in this block.
 *
 * time_incident_entries — the append-only activity thread (comments and state
 *   changes). Entries are only ever INSERTed; the service never updates or
 *   deletes one. This is the visible timeline the employee reads.
 *
 * Integrity (database level):
 *   - every row belongs to a company, and `time_incident_entries` cannot point
 *     at an incident of another company: the composite foreign key
 *     (incident_id, company_id) -> time_incidents (id, company_id) makes it
 *     structurally impossible on PostgreSQL (SQLite validates the same rule in
 *     the service; it cannot ALTER ADD a composite FK).
 *   - allowed type / status / kind values: CHECK constraints on PostgreSQL.
 *   - an incident can only carry a resolution and a resolver when it is closed,
 *     and `self_resolved` can only be set on the requester themselves.
 *   - the history is never silently destroyed: the FKs to Users are NO ACTION
 *     and `User.remove` refuses before deleting anything; the optional session
 *     and correction references are SET NULL so the incident survives them.
 *   - double submission: a partial UNIQUE index on (user_id, idempotency_key).
 *
 * ALL DDL RUNS IN ONE TRANSACTION (same guarantee as blocks 2 and 3): a failure
 * in the middle rolls the whole migration back and it can be re-run cleanly.
 */

const INCIDENT_TYPES = [
  'clocking_problem',
  'work_interruption',
  'schedule_discrepancy',
  'exceptional_circumstance',
  'other',
];

const INCIDENT_STATUSES = ['open', 'in_review', 'resolved', 'dismissed'];

const ENTRY_KINDS = ['comment', 'in_review', 'resolved', 'dismissed', 'link'];

function quotedList(values) {
  return values.map((v) => `'${v}'`).join(', ');
}

module.exports = {
  INCIDENT_TYPES,
  INCIDENT_STATUSES,
  ENTRY_KINDS,

  up: async (queryInterface, Sequelize) => {
    const dialect = queryInterface.sequelize.getDialect();

    await queryInterface.sequelize.transaction(async (transaction) => {
      // ---------------------------------------------------------------------
      // 1. The incident.
      // ---------------------------------------------------------------------
      await queryInterface.createTable('time_incidents', {
        id: { type: Sequelize.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
        company_id: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: 'Companies', key: 'id' },
        },
        // The employee who filed it.
        user_id: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: 'Users', key: 'id' },
        },
        // Optional related work session (an incident may exist without one).
        time_entry_id: {
          type: Sequelize.INTEGER, allowNull: true,
          references: { model: 'time_entries', key: 'id' },
          onDelete: 'SET NULL', onUpdate: 'CASCADE',
        },
        // Optional related correction request of block 3. The link neither
        // approves nor applies it.
        time_correction_id: {
          type: Sequelize.INTEGER, allowNull: true,
          references: { model: 'time_corrections', key: 'id' },
          onDelete: 'SET NULL', onUpdate: 'CASCADE',
        },
        // Civil date the incident refers to, in the effective timezone.
        local_date: { type: Sequelize.DATEONLY, allowNull: false },
        type: { type: Sequelize.STRING(32), allowNull: false },
        title: { type: Sequelize.STRING(200), allowNull: false },
        description: { type: Sequelize.TEXT, allowNull: false },
        status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'open' },
        // Client token of the form: the partial unique index below turns a
        // double submission into the same incident instead of a duplicate.
        idempotency_key: { type: Sequelize.STRING(64), allowNull: true },
        opened_at: { type: Sequelize.DATE, allowNull: false },
        review_started_at: { type: Sequelize.DATE, allowNull: true },
        resolved_at: { type: Sequelize.DATE, allowNull: true },
        resolved_by_id: {
          type: Sequelize.INTEGER, allowNull: true,
          references: { model: 'Users', key: 'id' },
        },
        // The answer the employee reads (required to resolve and to dismiss).
        resolution: { type: Sequelize.TEXT, allowNull: true },
        // Administrative self-resolution: the requester, holding the
        // administrative role, decided on their own incident.
        self_resolved: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        // Kept up to date on every entry / transition (block 5 reads it).
        last_activity_at: { type: Sequelize.DATE, allowNull: false },
        created_at: { type: Sequelize.DATE, allowNull: false },
        updated_at: { type: Sequelize.DATE, allowNull: false },
      }, { transaction });

      await queryInterface.addIndex('time_incidents', ['company_id', 'status'], { transaction });
      await queryInterface.addIndex('time_incidents', ['user_id', 'opened_at'], { transaction });
      await queryInterface.addIndex('time_incidents', ['status', 'opened_at'], { transaction });
      await queryInterface.addIndex('time_incidents', ['time_entry_id'], { transaction });
      await queryInterface.addIndex('time_incidents', ['time_correction_id'], { transaction });

      // Target of the composite foreign key of the thread (and a real
      // guarantee that an incident id is never ambiguous across companies).
      await queryInterface.addIndex('time_incidents', ['id', 'company_id'], {
        unique: true, name: 'time_incidents_id_company_unique', transaction,
      });

      // One incident per employee and client token: a double submission cannot
      // create two.
      await queryInterface.sequelize.query(
        'CREATE UNIQUE INDEX time_incidents_one_per_idempotency_key ' +
        'ON time_incidents (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL',
        { transaction }
      );

      // ---------------------------------------------------------------------
      // 2. The activity thread (append-only).
      // ---------------------------------------------------------------------
      await queryInterface.createTable('time_incident_entries', {
        id: { type: Sequelize.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
        company_id: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: 'Companies', key: 'id' },
        },
        incident_id: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: 'time_incidents', key: 'id' },
        },
        author_id: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: 'Users', key: 'id' },
        },
        // 'comment' (user text) or a state change ('in_review', 'resolved',
        // 'dismissed') or a link with a correction ('link').
        kind: { type: Sequelize.STRING(16), allowNull: false },
        body: { type: Sequelize.TEXT, allowNull: false },
        from_status: { type: Sequelize.STRING(16), allowNull: true },
        to_status: { type: Sequelize.STRING(16), allowNull: true },
        at: { type: Sequelize.DATE, allowNull: false },
        created_at: { type: Sequelize.DATE, allowNull: false },
        updated_at: { type: Sequelize.DATE, allowNull: false },
      }, { transaction });

      await queryInterface.addIndex('time_incident_entries', ['incident_id', 'at', 'id'], { transaction });
      await queryInterface.addIndex('time_incident_entries', ['company_id'], { transaction });
      await queryInterface.addIndex('time_incident_entries', ['author_id'], { transaction });
      await queryInterface.addIndex('time_incident_entries', ['kind'], { transaction });

      // ---------------------------------------------------------------------
      // 3. Value constraints (PostgreSQL only; SQLite validates in the service).
      // ---------------------------------------------------------------------
      if (dialect === 'postgres') {
        // The thread of one incident can never cross a company boundary.
        await queryInterface.sequelize.query(
          'ALTER TABLE time_incident_entries ADD CONSTRAINT time_incident_entries_incident_company_fk ' +
          'FOREIGN KEY (incident_id, company_id) REFERENCES time_incidents (id, company_id) ' +
          'ON DELETE RESTRICT ON UPDATE CASCADE',
          { transaction }
        );

        await queryInterface.sequelize.query(
          'ALTER TABLE time_incidents ADD CONSTRAINT time_incidents_type_check ' +
          `CHECK (type IN (${quotedList(INCIDENT_TYPES)}))`,
          { transaction }
        );
        await queryInterface.sequelize.query(
          'ALTER TABLE time_incidents ADD CONSTRAINT time_incidents_status_check ' +
          `CHECK (status IN (${quotedList(INCIDENT_STATUSES)}))`,
          { transaction }
        );
        await queryInterface.sequelize.query(
          'ALTER TABLE time_incidents ADD CONSTRAINT time_incidents_title_check ' +
          'CHECK (char_length(title) > 0)',
          { transaction }
        );
        // A closed incident always has a resolver, an instant and an answer.
        await queryInterface.sequelize.query(
          'ALTER TABLE time_incidents ADD CONSTRAINT time_incidents_resolution_check ' +
          "CHECK (status IN ('open', 'in_review') OR " +
          '(resolved_at IS NOT NULL AND resolved_by_id IS NOT NULL AND resolution IS NOT NULL))',
          { transaction }
        );
        // The administrative self-resolution can only point at the requester.
        await queryInterface.sequelize.query(
          'ALTER TABLE time_incidents ADD CONSTRAINT time_incidents_self_resolution_check ' +
          'CHECK (self_resolved = false OR ' +
          '(resolved_by_id IS NOT NULL AND resolved_by_id = user_id AND ' +
          "status IN ('resolved', 'dismissed')))",
          { transaction }
        );
        await queryInterface.sequelize.query(
          'ALTER TABLE time_incident_entries ADD CONSTRAINT time_incident_entries_kind_check ' +
          `CHECK (kind IN (${quotedList(ENTRY_KINDS)}))`,
          { transaction }
        );
        await queryInterface.sequelize.query(
          'ALTER TABLE time_incident_entries ADD CONSTRAINT time_incident_entries_to_status_check ' +
          'CHECK (to_status IS NULL OR ' +
          `to_status IN (${quotedList(INCIDENT_STATUSES)}))`,
          { transaction }
        );
      }
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      // The thread goes first: it references the incident.
      await queryInterface.dropTable('time_incident_entries', { transaction });
      await queryInterface.dropTable('time_incidents', { transaction });
    });
  },
};