'use strict';

/*
 * Database configuration (env-driven, Sequelize 6).
 *
 * HARD TEST ISOLATION: when NODE_ENV=test the database is ALWAYS a throwaway
 * SQLite file in the OS temp dir, regardless of any DB_* environment variables.
 * No test configuration can point the suite at an external/production database.
 */

require('dotenv').config();

const os = require('os');
const path = require('path');

const env = process.env.NODE_ENV || 'development';

if (env === 'test') {
  const storage = process.env.TEST_DB_STORAGE
    || path.join(os.tmpdir(), `timeoff-test-${process.pid}-${Date.now()}.sqlite`);
  module.exports = {
    dialect: 'sqlite',
    storage,
    logging: false,
    retry: { max: 3 },
  };
  return;
}

const dialect = process.env.DB_DIALECT || 'sqlite';

if (dialect === 'sqlite') {
  module.exports = {
    dialect: 'sqlite',
    storage: process.env.DB_STORAGE || path.join(__dirname, '..', 'db.development.sqlite'),
    logging: false,
  };
} else {
  // PostgreSQL (production option for Coolify).
  module.exports = {
    dialect,
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'timeoff',
    username: process.env.DB_USER || 'timeoff',
    password: process.env.DB_PASSWORD || '',
    logging: false,
    pool: { max: 10, min: 0, idle: 10000 },
    dialectOptions: process.env.DB_SSL === 'true' ? { ssl: { require: true, rejectUnauthorized: false } } : {},
  };
}
