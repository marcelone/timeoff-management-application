'use strict';

/*
 * Database layer (Sequelize 6).
 *
 * Loads the legacy model definitions through the compatibility adapter so the
 * existing functional logic is preserved while running on Sequelize 6.
 * Associations, scopes and scope-based associations are wired exactly as before.
 */

require('../../promise-shim');

const fs = require('fs');
const path = require('path');
const { Sequelize, DataTypes } = require('sequelize');
const { install, OP_MAP, enableScopeGetters } = require('./compat');
const dbConfig = require('../../../config/database');

const sequelize = install(new Sequelize({
  ...dbConfig,
  // Transitional: accept legacy string operators ($ne, $or, ...). See compat.js.
  operatorsAliases: OP_MAP,
  logging: dbConfig.logging || false,
}));

// SQLite: enforce referential integrity and use WAL for concurrency.
if (sequelize.getDialect() === 'sqlite') {
  sequelize.addHook('afterConnect', (connection) => new Promise((resolve, reject) => {
    connection.run('PRAGMA foreign_keys = ON;', (err) => {
      if (err) return reject(err);
      connection.run('PRAGMA journal_mode = WAL;', () => resolve());
    });
  }));
}

const db = {};

fs.readdirSync(__dirname)
  .filter((file) => file.endsWith('.js') && file !== 'index.js' && file !== 'compat.js')
  .forEach((file) => {
    const define = require(path.join(__dirname, file));
    const model = define(sequelize, DataTypes);
    db[model.name] = model;
  });

// Link models according to associations.
Object.keys(db).forEach((modelName) => {
  if ('associate' in db[modelName]) db[modelName].associate(db);
});

// Add scopes.
Object.keys(db).forEach((modelName) => {
  if ('loadScope' in db[modelName]) db[modelName].loadScope(db);
});

// Link models based on associations that are based on scopes.
Object.keys(db).forEach((modelName) => {
  if ('scopeAssociate' in db[modelName]) db[modelName].scopeAssociate(db);
});

// Transitional: support legacy `{ scope: [...] }` option on association getters.
enableScopeGetters(sequelize);

db.sequelize = sequelize;
db.Sequelize = Sequelize;

module.exports = db;
