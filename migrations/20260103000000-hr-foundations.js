'use strict';

/*
 * HR SaaS foundations:
 *  - WorkCenters table (centers per company).
 *  - Users.workCenterId (optional link to a center).
 *  - Users.role (role-based access foundation; admin boolean kept for compatibility).
 *  - Companies.plan / subscription_status (commercial subscription readiness).
 * All additive and nullable/defaulted; no existing data semantics changed.
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('WorkCenters', {
      id: { type: Sequelize.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
      name: { type: Sequelize.STRING, allowNull: false },
      address: { type: Sequelize.STRING, allowNull: true },
      timezone: { type: Sequelize.STRING, allowNull: true },
      companyId: {
        type: Sequelize.INTEGER, allowNull: false,
        references: { model: 'Companies', key: 'id' },
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('WorkCenters', ['companyId']);

    await queryInterface.addColumn('Users', 'workCenterId', {
      type: Sequelize.INTEGER, allowNull: true,
      references: { model: 'WorkCenters', key: 'id' },
    });
    await queryInterface.addColumn('Users', 'role', {
      type: Sequelize.STRING, allowNull: false, defaultValue: 'employee',
    });
    await queryInterface.addColumn('Companies', 'plan', {
      type: Sequelize.STRING, allowNull: false, defaultValue: 'free',
    });
    await queryInterface.addColumn('Companies', 'subscription_status', {
      type: Sequelize.STRING, allowNull: false, defaultValue: 'active',
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('Companies', 'subscription_status');
    await queryInterface.removeColumn('Companies', 'plan');
    await queryInterface.removeColumn('Users', 'role');
    await queryInterface.removeColumn('Users', 'workCenterId');
    await queryInterface.dropTable('WorkCenters');
  },
};
