'use strict';

/*
 * Secure password-reset fields.
 * Replaces the legacy deterministic, non-expiring reset token (base64 of
 * email + MD5(password)) with a random persisted secret + expiry.
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('Users', 'reset_password_token', {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await queryInterface.addColumn('Users', 'reset_password_expires', {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('Users', 'reset_password_expires');
    await queryInterface.removeColumn('Users', 'reset_password_token');
  },
};
