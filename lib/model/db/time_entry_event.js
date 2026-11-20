'use strict';

/*
 * TimeEntryEvent — append-only log of what actually happened during a work
 * session. Block 1 writes exactly two rows per session: 'in' and 'out'.
 *
 * Why a separate table instead of columns on TimeEntry:
 *   - pauses (pause_start/pause_end), corrections and automatic closings must be
 *     added later as new event types, not as new columns on a mutable row;
 *   - `source` already distinguishes a direct clock from a declared (retroactive)
 *     time or an automatic closing, which the product requires to never present
 *     an estimate as a verified real time;
 *   - the log is immutable (no updatedAt), so "keep the original record" is a
 *     structural property rather than a convention.
 *
 * Block 3 adds the 'correction' event type. A correction event points to the
 * request that caused it (correction_id) and carries the JSON payload with the
 * change (what moved, from -> to, origin, reason). The original 'in' / 'out' /
 * 'break_start' / 'break_end' rows are never rewritten: the effective values
 * live on time_entries / time_breaks, and the originals stay here forever.
 */

module.exports = function (sequelize, DataTypes) {
  const TimeEntryEvent = sequelize.define('TimeEntryEvent', {
    companyId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    timeEntryId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    type: {
      type: DataTypes.STRING(16),
      allowNull: false,
      validate: { isIn: [['in', 'out', 'break_start', 'break_end', 'correction']] },
    },
    occurredAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    source: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'direct',
      validate: { isIn: [['direct', 'declared', 'auto', 'corrected']] },
    },
    modality: {
      type: DataTypes.STRING(16),
      allowNull: true,
    },
    // Block 3: the correction request that produced this event (NULL for the
    // original clock/break events).
    correctionId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    // Block 3: JSON payload of a correction event.
    payload: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  }, {
    underscored: true,
    freezeTableName: true,
    tableName: 'time_entry_events',
    updatedAt: false,

    indexes: [
      { fields: ['company_id'] },
      { fields: ['time_entry_id'] },
      { fields: ['user_id', 'occurred_at'] },
      { fields: ['correction_id'] },
    ],

    classMethods: {
      associate: function (models) {
        TimeEntryEvent.belongsTo(models.Company, { as: 'company', foreignKey: 'companyId' });
        TimeEntryEvent.belongsTo(models.User, { as: 'user', foreignKey: 'userId' });
        TimeEntryEvent.belongsTo(models.TimeEntry, { as: 'time_entry', foreignKey: 'timeEntryId' });
      },
      type_in: function () { return 'in'; },
      type_out: function () { return 'out'; },
      type_correction: function () { return 'correction'; },
    },
  });

  return TimeEntryEvent;
};
