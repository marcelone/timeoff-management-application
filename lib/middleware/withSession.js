'use strict';

/*
 * Session middleware (hardened).
 * - Secret from SESSION_SECRET env (required in production).
 * - Cookie: httpOnly, sameSite=lax, secure in production.
 * - Store: Sequelize (Sessions table, created by migration) or optional Redis 4.
 */

const session = require('express-session');
const SequelizeStore = require('connect-session-sequelize')(session.Store);
const config = require('../config');

module.exports = function createSessionMiddleware({ sequelizeDb }) {
  const sessionStoreCfg = config.get('sessionStore') || {};
  const useRedis = String(config.get('use_redis')) === 'true' || sessionStoreCfg.useRedis === true;

  let store;
  if (useRedis) {
    const { createClient } = require('redis');
    const RedisStore = require('connect-redis').default || require('connect-redis');
    const host = config.get('redis_host') || (sessionStoreCfg.redisConnectionConfiguration || {}).host || '127.0.0.1';
    const port = parseInt(config.get('redis_port') || (sessionStoreCfg.redisConnectionConfiguration || {}).port || 6379, 10);
    const client = createClient({ socket: { host, port } });
    client.on('error', (err) => console.error('Redis session store error:', err));
    client.connect().catch((err) => console.error('Redis connect failed:', err));
    store = new RedisStore({ client, prefix: 'timeoff:sess:' });
  } else {
    if (!sequelizeDb) throw new Error('Database connection was not provided into Session store manager!');
    store = new SequelizeStore({ db: sequelizeDb });
  }

  const secret = process.env.SESSION_SECRET || config.get('session_secret');
  const isProd = process.env.NODE_ENV === 'production';
  if (!secret && isProd) {
    throw new Error('SESSION_SECRET environment variable is required in production');
  }

  return session({
    store,
    secret: secret || 'dev-only-insecure-secret-change-me',
    resave: false,
    saveUninitialized: false,
    name: 'timeoff.sid',
    cookie: {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  });
};
