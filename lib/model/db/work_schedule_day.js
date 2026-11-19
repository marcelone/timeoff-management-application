'use strict';

/*
 * WorkScheduleDay — expected (planned) working hours for one weekday in one
 * scope. This is the single source of truth for *expected* working time inside
 * the time-tracking module; it never produces worked time by itself.
 *
 * One row per (company, scope, weekday). The scope hierarchy is resolved in
 * lib/modules/time/schedule.js as: user > department > company (most specific
 * wins, per weekday).
 *
 * `isWorkingDay` distinguishes the two states that must not be confused:
 *   - no row at all            -> inherit from the next wider scope
 *   - row with isWorkingDay=false -> explicitly a non-working day (stops inheritance)
 *   - row with isWorkingDay=true  -> working day with hours
 * This is what makes a part-time schedule possible (Mon only) without silently
 * inheriting the company's Mon-Fri when Tue-Fri are explicitly disabled.
 *
 * Why not reuse the existing Schedule model: Schedule models *which days* an
 * employee works for absence/allowance calculation (whole day / none / half
 * days) and is attached to a company or a user, but it carries no hours. Adding
 * hour columns there, plus a department scope, would overload a model used by the
 * absence engine. Keeping expected hours here avoids two competing sources for
 * the same question inside this module.
 */

module.exports = function (sequelize, DataTypes) {
  const WorkScheduleDay = sequelize.define('WorkScheduleDay', {
    companyId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    scopeType: {
      type: DataTypes.STRING(16),
      allowNull: false,
      validate: { isIn: [['company', 'department', 'user']] },
    },
    scopeId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    // ISO weekday: 1 = Monday ... 7 = Sunday (matches moment().isoWeekday()).
    weekday: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: { min: 1, max: 7 },
    },
    isWorkingDay: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    // 'HH:MM' in the company/center timezone; NULL on an explicit non-working day.
    // A planned shift never crosses midnight in block 1 (startTime < endTime).
    startTime: {
      type: DataTypes.STRING(5),
      allowNull: true,
    },
    endTime: {
      type: DataTypes.STRING(5),
      allowNull: true,
    },
  }, {
    underscored: true,
    freezeTableName: true,
    tableName: 'work_schedule_days',

    indexes: [
      { fields: ['company_id'] },
      { unique: true, fields: ['company_id', 'scope_type', 'scope_id', 'weekday'] },
    ],

    validate: {
      timesConsistentWithWorkingFlag: function () {
        const re = /^([01]\d|2[0-3]):[0-5]\d$/;
        if (this.isWorkingDay === false) {
          if (this.startTime || this.endTime) {
            throw new Error('WorkScheduleDay: a non-working day must not carry hours');
          }
          return;
        }
        if (!this.startTime || !this.endTime) {
          throw new Error('WorkScheduleDay: a working day needs start and end times');
        }
        if (!re.test(this.startTime) || !re.test(this.endTime)) {
          throw new Error('WorkScheduleDay: times must be HH:MM');
        }
        if (this.startTime >= this.endTime) {
          throw new Error('WorkScheduleDay: startTime must be before endTime');
        }
      },
    },

    classMethods: {
      associate: function (models) {
        WorkScheduleDay.belongsTo(models.Company, { as: 'company', foreignKey: 'companyId' });
      },
      scopes: function () {
        return ['company', 'department', 'user'];
      },
    },
  });

  return WorkScheduleDay;
};