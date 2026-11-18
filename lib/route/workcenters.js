'use strict';

/*
 * WorkCenter management API (tenant-guarded).
 *
 * Demonstrates real (not declarative) integration of the centralized auth
 * foundations: ensureTenantApi + requirePermissionApi + scopeByCompany +
 * assertSameCompany. Every operation is scoped to the acting user's company;
 * direct identifiers from another company are rejected (404) and never mutated.
 *
 * Cookie-authenticated => CSRF applies (X-CSRF-Token header or _csrf field).
 */

const express = require('express');
const router = express.Router();
const { ensureTenantApi, scopeByCompany, assertSameCompany } = require('../auth/tenant');
const { requirePermissionApi } = require('../auth/permissions');

router.use(ensureTenantApi, requirePermissionApi('workcenters.manage'));

router.get('/', async (req, res) => {
  const db = req.app.get('db_model');
  const centers = await db.WorkCenter.findAll({
    where: scopeByCompany(req.user, {}),
    order: [['name', 'ASC']],
  });
  res.json({ data: centers.map((c) => ({ id: c.id, name: c.name, address: c.address, timezone: c.timezone })) });
});

router.post('/', async (req, res) => {
  const db = req.app.get('db_model');
  const name = String((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const c = await db.WorkCenter.create({
    name,
    address: (req.body && req.body.address) || null,
    timezone: (req.body && req.body.timezone) || null,
    companyId: req.user.companyId, // forced to acting company
  });
  res.status(201).json({ data: { id: c.id, name: c.name, companyId: c.companyId } });
});

router.put('/:id', async (req, res) => {
  const db = req.app.get('db_model');
  const c = await db.WorkCenter.findByPk(req.params.id);
  try {
    assertSameCompany(req.user, c);
  } catch (e) {
    return res.status(404).json({ error: 'not found' });
  }
  if (req.body && req.body.name) c.name = String(req.body.name).trim();
  if (req.body && req.body.address !== undefined) c.address = req.body.address;
  await c.save();
  res.json({ data: { id: c.id, name: c.name } });
});

router.delete('/:id', async (req, res) => {
  const db = req.app.get('db_model');
  const c = await db.WorkCenter.findByPk(req.params.id);
  try {
    assertSameCompany(req.user, c);
  } catch (e) {
    return res.status(404).json({ error: 'not found' });
  }
  await c.destroy();
  res.json({ ok: true });
});

module.exports = router;
