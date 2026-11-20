'use strict';

/*
 * TimeCorrection — a REQUEST to correct a recorded work session (block 3).
 *
 * A correction never destroys the original: it is a request row that keeps the
 * original value, the proposed value, the reason, the policy that applied when
 * it was submitted, and who resolved it and when. Applying a correction
 * updates the effective projection (time_entries / time_breaks) and appends a
 * 'correction' event to the session timeline; the original 'in' / 'out' /
 * 'break_start' / 'break_end' events are never rewritten.
 *
 * States:
 *   pending  -> waiting for a supervisor (approval_required policy)
 *   approved -> the decision was taken; the request is being applied. This state
 *               only exists INSIDE the resolution transaction, so a request is
 *               never observable as "approved" while it is not applied.
 *   applied  -> the effective data was changed (and the change audited)
 *   rejected -> the supervisor refused it; `rejection_reason` says why
 *   conflict -> the underlying session changed after the request was created, so
 *               it could not be applied blindly. The request is preserved and
 *               needs a human decision.
 *
 * `targetKey` identifies WHAT is being corrected ("entry:12:start"). A partial
 * unique index in the database guarantees one pending request per target and
 * employee.
 *
 * `policy` stores the policy that was in force WHEN the request was submitted:
 * changing the company policy later neither approves pending requests nor
 * reclassifies existing ones.
 *
 * `selfApproved` marks the ADMINISTRATIVE SELF-APPROVAL: the request was
 * approved by its own requester, who held the administrative role of the
 * company (owner/admin). It is an explicit administrative exception, never a
 * supervisor decision: a department boss, a Department Supervisor or an
 * employee can never set it. It is false for every request that was decided by
 * somebody else, and for the requests that are still pending.
 */

const CORRECTION_TYPES = [
  'entry_start',
  'entry_end',
  'missing_entry',
  'break_start',
  'break_end',
  'break_type',
  'break_missing',
  'modality',
];

const CORRECTION_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'applied',
  'conflict',
  'cancelled',
];

const CORRECTION_POLICIES = [
  'self_service',
  'approval_required',
];

module.exports = function (sequelize, DataTypes) {
  const TimeCorrection = sequelize.define('TimeCorrection', {
    companyId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    // The employee who asked for the correction.
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    // Affected session. NULL while a forgotten session is only a request.
    timeEntryId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    // Affected break, when the correction targets a break.
    timeBreakId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    type: {
      type: DataTypes.STRING(24),
      allowNull: false,
      validate: { isIn: [CORRECTION_TYPES] },
    },
    status: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'pending',
      validate: { isIn: [CORRECTION_STATUSES] },
    },
    targetKey: {
      type: DataTypes.STRING(80),
      allowNull: false,
    },
    // JSON snapshots (see lib/modules/time/corrections.js for the payloads).
    originalValue: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    proposedValue: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    reason: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    policy: {
      type: DataTypes.STRING(24),
      allowNull: false,
      validate: { isIn: [CORRECTION_POLICIES] },
    },
    entryVersion: {
      type: DataTypes.INTEGER,
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
    rejectionReason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    conflictReason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    // True only when the request was approved by its own requester holding the
    // administrative role (owner/admin) of the company.
    selfApproved: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
  }, {
    underscored: true,
    freezeTableName: true,
    tableName: 'time_corrections',

    indexes: [
      { fields: ['company_id'] },
      { fields: ['user_id', 'created_at'] },
      { fields: ['status', 'company_id'] },
      { fields: ['time_entry_id'] },
      { fields: ['time_break_id'] },
    ],

    classMethods: {
      associate: function (models) {
        TimeCorrection.belongsTo(models.Company, { as: 'company', foreignKey: 'companyId' });
        TimeCorrection.belongsTo(models.User, { as: 'user', foreignKey: 'userId' });
        TimeCorrection.belongsTo(models.User, { as: 'resolved_by', foreignKey: 'resolvedById' });
        TimeCorrection.belongsTo(models.TimeEntry, { as: 'time_entry', foreignKey: 'timeEntryId' });
        TimeCorrection.belongsTo(models.TimeBreak, { as: 'time_break', foreignKey: 'timeBreakId' });
      },
      types: function () { return CORRECTION_TYPES.slice(); },
      statuses: function () { return CORRECTION_STATUSES.slice(); },
      policies: function () { return CORRECTION_POLICIES.slice(); },
    },
  });

  return TimeCorrection;
};
