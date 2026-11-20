'use strict';

/*
 * TimeBreak — one break inside a work session (block 2).
 *
 * `countsAsWork` is copied from the company policy when the break STARTS and is
 * never recomputed. That is what makes "changing today's policy must not silently
 * recompute already closed sessions" true by construction: the historical break
 * keeps the criterion that was in force while it happened.
 *
 * Breaks are delimited by instants (server clock, UTC) and are also mirrored as
 * `break_start` / `break_end` events in time_entry_events, so the session keeps a
 * single append-only timeline. The row itself holds the state that queries need
 * (open/closed) without walking the event log.
 */

module.exports = function (sequelize, DataTypes) {
  const TimeBreak = sequelize.define('TimeBreak', {
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
      validate: { isIn: [['regular', 'personal', 'justified']] },
    },
    countsAsWork: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
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
    tableName: 'time_breaks',

    indexes: [
      { fields: ['company_id'] },
      { fields: ['time_entry_id'] },
      { fields: ['user_id', 'started_at'] },
    ],

    validate: {
      endedAfterStarted: function () {
        if (this.endedAt && this.startedAt &&
            new Date(this.endedAt).getTime() <= new Date(this.startedAt).getTime()) {
          throw new Error('TimeBreak: ended_at must be after started_at');
        }
      },
    },

    classMethods: {
      associate: function (models) {
        TimeBreak.belongsTo(models.Company, { as: 'company', foreignKey: 'companyId' });
        TimeBreak.belongsTo(models.User, { as: 'user', foreignKey: 'userId' });
        TimeBreak.belongsTo(models.TimeEntry, { as: 'time_entry', foreignKey: 'timeEntryId' });
      },
    },
  });

  return TimeBreak;
};