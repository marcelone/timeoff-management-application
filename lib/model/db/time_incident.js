'use strict';

/*
 * TimeIncident — a work-time INCIDENT (block 4).
 *
 * PRINCIPLE: AN INCIDENT COMMUNICATES, IT DOES NOT CORRECT.
 *
 * Block 3 answers "I clocked in at 09:30, it should be 09:00": that is a
 * correction, and it changes the effective record through an approved request.
 * This table answers "the clocking system was down and I need to explain what
 * happened": it records the situation, the conversation and the answer, and it
 * NEVER touches a clock time, a break or the computation.
 *
 * An incident can reference an optional work session (`timeEntryId`) and an
 * optional correction request of block 3 (`timeCorrectionId`). The reference is
 * only a pointer: it neither approves nor applies the correction, and a
 * correction in conflict never resolves the incident by itself.
 *
 * States (see lib/modules/time/incidents.js for the allowed transitions):
 *   open       -> filed by the employee, nobody has looked at it yet
 *   in_review  -> a responsible person is reviewing it
 *   resolved   -> an answer was given; `resolution` says which
 *   dismissed  -> closed without action; `resolution` says why
 *
 * The history is append-only: the visible thread lives in
 * TimeIncidentEntry, and every change is also written to the `audit` table
 * (entity_type = 'TIME_INCIDENT'). `selfResolved` marks the administrative
 * self-resolution, exactly as block 3 does for corrections.
 */

const INCIDENT_TYPES = [
  'clocking_problem',
  'work_interruption',
  'schedule_discrepancy',
  'exceptional_circumstance',
  'other',
];

const INCIDENT_STATUSES = ['open', 'in_review', 'resolved', 'dismissed'];

module.exports = function (sequelize, DataTypes) {
  const TimeIncident = sequelize.define('TimeIncident', {
    companyId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    // The employee who filed the incident.
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    // Optional related work session: an incident may exist without one.
    timeEntryId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    // Optional related correction request (block 3). Never approved or applied
    // from here.
    timeCorrectionId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    // Civil date the incident refers to, in the effective timezone.
    localDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    type: {
      type: DataTypes.STRING(32),
      allowNull: false,
      validate: { isIn: [INCIDENT_TYPES] },
    },
    title: {
      type: DataTypes.STRING(200),
      allowNull: false,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    status: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'open',
      validate: { isIn: [INCIDENT_STATUSES] },
    },
    idempotencyKey: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    openedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    reviewStartedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    resolvedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    resolvedById: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    // The answer the employee reads. Required to resolve and to dismiss.
    resolution: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    // True only when the requester, holding the administrative role of the
    // company, decided on their own incident.
    selfResolved: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    // Updated on every activity: block 5 uses it to detect "new answer",
    // "state changed" and "pending for too long" without a scheduler here.
    lastActivityAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  }, {
    underscored: true,
    freezeTableName: true,
    tableName: 'time_incidents',

    indexes: [
      { fields: ['company_id', 'status'] },
      { fields: ['user_id', 'opened_at'] },
      { fields: ['status', 'opened_at'] },
      { fields: ['time_entry_id'] },
      { fields: ['time_correction_id'] },
    ],

    classMethods: {
      associate: function (models) {
        TimeIncident.belongsTo(models.Company, { as: 'company', foreignKey: 'companyId' });
        TimeIncident.belongsTo(models.User, { as: 'user', foreignKey: 'userId' });
        TimeIncident.belongsTo(models.User, { as: 'resolved_by', foreignKey: 'resolvedById' });
        TimeIncident.belongsTo(models.TimeEntry, { as: 'time_entry', foreignKey: 'timeEntryId' });
        TimeIncident.belongsTo(models.TimeCorrection, {
          as: 'time_correction', foreignKey: 'timeCorrectionId',
        });
        TimeIncident.hasMany(models.TimeIncidentEntry, {
          as: 'entries', foreignKey: 'incidentId',
        });
      },
      types: function () { return INCIDENT_TYPES.slice(); },
      statuses: function () { return INCIDENT_STATUSES.slice(); },
    },
  });

  TimeIncident.INCIDENT_TYPES = INCIDENT_TYPES;
  TimeIncident.INCIDENT_STATUSES = INCIDENT_STATUSES;

  return TimeIncident;
};