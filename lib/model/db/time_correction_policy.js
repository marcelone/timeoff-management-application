'use strict';

/*
 * TimeCorrectionPolicy — per company: how a correction request is resolved.
 *
 *   'self_service'      -> the employee's correction is applied immediately.
 *   'approval_required' -> a supervisor has to approve it before it changes
 *                           the effective record.
 *
 * Absent row means the explicit initial default ('approval_required'): the
 * prudent choice, so a company that never configured anything does not silently
 * let employees rewrite their own clock history.
 *
 * The policy is snapshotted onto every request (time_corrections.policy), so
 * changing it never reclassifies requests that are already pending or resolved.
 */

const MODES = ['self_service', 'approval_required'];
const DEFAULT_MODE = 'approval_required';

module.exports = function (sequelize, DataTypes) {
  const TimeCorrectionPolicy = sequelize.define('TimeCorrectionPolicy', {
    companyId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    mode: {
      type: DataTypes.STRING(24),
      allowNull: false,
      defaultValue: DEFAULT_MODE,
      validate: { isIn: [MODES] },
    },
  }, {
    underscored: true,
    freezeTableName: true,
    tableName: 'time_correction_policies',

    indexes: [
      { unique: true, fields: ['company_id'] },
    ],

    classMethods: {
      associate: function (models) {
        TimeCorrectionPolicy.belongsTo(models.Company, { as: 'company', foreignKey: 'companyId' });
      },
      modes: function () { return MODES.slice(); },
      default_mode: function () { return DEFAULT_MODE; },
    },
  });

  return TimeCorrectionPolicy;
};
