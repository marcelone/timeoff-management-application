'use strict';

/*
 * BreakPolicy — per company and break type: does this break count as worked time?
 *
 * Absent row means the explicit initial default (false: the break does not count
 * as worked time). Rows are created when an administrator saves the configuration,
 * so the stored state reflects a decision rather than an implicit guess.
 *
 * Only company-level configuration exists in block 2 (no per-employee overrides,
 * as required). The policy is snapshotted onto each break when it starts, so a
 * later policy change never rewrites history.
 */

module.exports = function (sequelize, DataTypes) {
  const BreakPolicy = sequelize.define('BreakPolicy', {
    companyId: {
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
  }, {
    underscored: true,
    freezeTableName: true,
    tableName: 'break_policies',

    indexes: [
      { unique: true, fields: ['company_id', 'type'] },
    ],

    classMethods: {
      associate: function (models) {
        BreakPolicy.belongsTo(models.Company, { as: 'company', foreignKey: 'companyId' });
      },
    },
  });

  return BreakPolicy;
};