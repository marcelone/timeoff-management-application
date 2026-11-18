'use strict';

const assert = require('assert');
const express = require('express');
const request = require('supertest');
const { createAuthRateLimit } = require('../../lib/middleware/auth-rate-limit');

describe('auth rate limiting (real middleware)', () => {
  it('returns 429 after exceeding the limit on auth POSTs', async () => {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(createAuthRateLimit({ max: 3, windowMs: 60000 }));
    app.post('/login', (req, res) => res.status(200).json({ ok: true }));

    const ag = request.agent(app);
    for (let i = 0; i < 3; i++) {
      const r = await ag.post('/login').type('form').send({ username: 'x', password: 'y' });
      assert.strictEqual(r.status, 200, `request ${i + 1} allowed`);
    }
    const blocked = await ag.post('/login').type('form').send({ username: 'x', password: 'y' });
    assert.strictEqual(blocked.status, 429, 'fourth request rate-limited');
  });

  it('does not limit non-auth paths', async () => {
    const app = express();
    app.use(createAuthRateLimit({ max: 1, windowMs: 60000 }));
    app.post('/other', (req, res) => res.status(200).json({ ok: true }));
    const ag = request.agent(app);
    for (let i = 0; i < 3; i++) {
      const r = await ag.post('/other');
      assert.strictEqual(r.status, 200);
    }
  });
});
