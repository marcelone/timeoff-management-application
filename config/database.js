'use strict';

/*
 * Database configuration (env-driven, Sequelize 6).
 *
 * HARD TEST ISOLATION: when NODE_ENV=test the database is ALWAYS a throwaway
 * SQLite file in the OS temp dir, regardless of any DB_* environment variables.
 * No test configuration can point the suite at an external/production database.
 *
 * Production: PostgreSQL is the preferred engine (DB_DIALECT=postgres).
 * SQLite remains available for development/single-container deployments.
 */

require('dotenv').config();

const os = require('os');
const path = require('path');
const fs = require('fs');

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
} else if (dialect === 'postgres') {
  const dialectOptions = {};
  if (process.env.DB_SSL === 'true') {
    // TLS with certificate verification ON by default. Explicit opt-out only via
    // DB_SSL_REJECT_UNAUTHORIZED=false (e.g. managed DB with self-signed cert).
    const ssl = {
      require: true,
      rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
    };
    if (process.env.DB_SSL_CA) {
      ssl.ca = fs.readFileSync(process.env.DB_SSL_CA, 'utf8');
    }
    dialectOptions.ssl = ssl;
  }
  module.exports = {
    dialect: 'postgres',
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'timeoff',
    username: process.env.DB_USER || 'timeoff',
    password: process.env.DB_PASSWORD || '',
    logging: false,
    pool: { max: 10, min: 0, idle: 10000 },
    dialectOptions,
  };
} else {
  throw new Error(`Unsupported DB_DIALECT: ${dialect} (use sqlite or postgres)`);
}
