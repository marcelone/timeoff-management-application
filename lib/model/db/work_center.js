'use strict';

/*
 * WorkCenter (centre de treball) — HR foundation.
 * Employees belong to a company and optionally to a work center. Multi-center
 * support is required for shift planning and time-tracking modules (future).
 */

module.exports = function (sequelize, DataTypes) {
  const WorkCenter = sequelize.define('WorkCenter', {
    name: { type: DataTypes.STRING, allowNull: false },
    address: { type: DataTypes.STRING, allowNull: true },
    timezone: { type: DataTypes.STRING, allowNull: true },
  }, {
    indexes: [{ fields: ['companyId'] }],
    classMethods: {
      associate: function (models) {
        WorkCenter.belongsTo(models.Company, { as: 'company', foreignKey: 'companyId' });
        WorkCenter.hasMany(models.User, { as: 'users', foreignKey: 'workCenterId' });
      },
    },
    instanceMethods: {},
  });

  return WorkCenter;
};
