'use strict';

/*
 * Migration runner (Umzug 3 + Sequelize 6 storage).
 * Replaces the legacy sequelize-cli 2.x (which crashed on Node >=12 via
 * graceful-fs/natives). Migrations are Sequelize-style: up(queryInterface, Sequelize).
 * Schema is applied by migrations BEFORE the app listens (no sequelize.sync()).
 */

require('./promise-shim');

const path = require('path');
const { Umzug, SequelizeStorage } = require('umzug');
const Sequelize = require('sequelize');

function buildUmzug(sequelize) {
  return new Umzug({
    migrations: {
      glob: ['migrations/*.js', { cwd: path.join(__dirname, '..') }],
      resolve: ({ name, path: migrationPath, context }) => {
        const migration = require(migrationPath);
        return {
          name,
          up: async () => migration.up(context, Sequelize),
          down: async () => migration.down(context, Sequelize),
        };
      },
    },
    context: sequelize.getQueryInterface(),
    storage: new SequelizeStorage({ sequelize }),
    logger: console,
  });
}

async function runMigrations(sequelize) {
  const db = sequelize ? { sequelize } : require('./model/db');
  const umzug = buildUmzug(db.sequelize);
  const applied = await umzug.up();
  return { umzug, applied };
}

module.exports = { runMigrations, buildUmzug };
