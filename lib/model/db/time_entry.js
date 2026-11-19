'use strict';

/*
 * TimeEntry — one work session ("jornada") for a user inside a company.
 *
 * Block 1 only records clock-in / clock-out. This table keeps the *state* of the
 * session (open/closed) plus the two boundary instants; the immutable facts of
 * what happened (in/out, and later pauses, corrections and automatic closings)
 * live in TimeEntryEvent. Rationale for splitting: future features append facts
 * instead of overloading this row with speculative columns, and history stays
 * append-only while `status` remains a cheap query.
 *
 * Invariants (also enforced in the database, see the migration):
 *   - at most one OPEN entry per user  -> partial UNIQUE index on user_id WHERE status='open'
 *   - ended_at is NULL or strictly after started_at
 *
 * Instants are stored as UTC timestamps produced by the server (never by the
 * browser) and rendered in the company/center timezone by the routes.
 */

module.exports = function (sequelize, DataTypes) {
  const TimeEntry = sequelize.define('TimeEntry', {
    companyId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    modality: {
      type: DataTypes.STRING(16),
      allowNull: false,
      validate: { isIn: [['office', 'remote', 'travel']] },
    },
    status: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'open',
      validate: { isIn: [['open', 'closed']] },
    },
    startedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    endedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  }, {
    underscored: true,
    freezeTableName: true,
    tableName: 'time_entries',

    indexes: [
      { fields: ['company_id'] },
      { fields: ['user_id', 'status'] },
    ],

    validate: {
      endedAfterStarted: function () {
        if (this.endedAt && this.startedAt &&
            new Date(this.endedAt).getTime() <= new Date(this.startedAt).getTime()) {
          throw new Error('TimeEntry: ended_at must be after started_at');
        }
      },
    },

    classMethods: {
      associate: function (models) {
        TimeEntry.belongsTo(models.Company, { as: 'company', foreignKey: 'companyId' });
        TimeEntry.belongsTo(models.User, { as: 'user', foreignKey: 'userId' });
        TimeEntry.hasMany(models.TimeEntryEvent, { as: 'events', foreignKey: 'timeEntryId' });
      },
      modality_values: function () {
        return ['office', 'remote', 'travel'];
      },
      status_open: function () { return 'open'; },
      status_closed: function () { return 'closed'; },
    },
  });

  return TimeEntry;
};