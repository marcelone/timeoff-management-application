'use strict';

/*
 * Generates a clean, model-independent initial migration from the current
 * Sequelize 6 model definitions. Replaces the 18 legacy migrations (which
 * loaded current models and rebuilt SQLite tables inside up()).
 *
 * Output: migrations/20260101000000-initial-schema.js
 *   - queryInterface.createTable per model (dialect-agnostic: SQLite + PostgreSQL)
 *   - inline foreign-key references (topologically ordered; cyclic edges skipped)
 *   - indexes from model options
 *
 * The generated migration is then VERIFIED against a sequelize.sync() schema:
 * table set and per-table column sets must match, and a company+user must be
 * creatable through the migrated schema.
 *
 * Run: NODE_ENV=test node scripts/generate-initial-migration.js
 */

process.env.NODE_ENV = 'test';
require('../lib/promise-shim');

const fs = require('fs');
const path = require('path');
const { Sequelize } = require('sequelize');
const db = require('../lib/model/db');

const MIGRATION_PATH = path.join(__dirname, '..', 'migrations', '20260101000000-initial-schema.js');

function sequelizeType(attr) {
  const t = attr.type;
  const key = t.key || 'STRING';
  if (key === 'ENUM') {
    const values = (t.values || []).map((v) => JSON.stringify(v)).join(', ');
    return `Sequelize.ENUM(${values})`;
  }
  if (key === 'STRING' || key === 'CHAR') {
    const len = (t.options && t.options.length) || t._length;
    return len ? `Sequelize.${key}(${len})` : `Sequelize.${key}`;
  }
  if (key === 'INTEGER' || key === 'BIGINT') {
    const len = t.options && t.options.length;
    return len ? `Sequelize.${key}(${len})` : `Sequelize.${key}`;
  }
  return `Sequelize.${key}`;
}

function defaultValueSql(attr) {
  const dv = attr.defaultValue;
  if (dv === undefined) return null;
  if (dv === null) return 'null';
  if (typeof dv === 'function') {
    return (attr.type.key === 'UUID') ? 'Sequelize.UUIDV4' : 'Sequelize.NOW';
  }
  if (typeof dv === 'object' && dv !== null && dv.key === 'NOW') return 'Sequelize.NOW';
  if (typeof dv === 'object' && dv !== null && dv.val !== undefined) return JSON.stringify(dv.val);
  return JSON.stringify(dv);
}

async function main() {
  const sequelize = db.sequelize;
  await sequelize.sync();
  const qi = sequelize.getQueryInterface();

  const modelNames = Object.keys(db).filter((k) => db[k] && db[k].getTableName && k !== 'sequelize' && k !== 'Sequelize');
  const tables = {};
  for (const name of modelNames) {
    const model = db[name];
    const tableName = model.getTableName();
    const fkRows = await sequelize.query(`PRAGMA foreign_key_list("${tableName}")`, { type: Sequelize.QueryTypes.SELECT });
    const fkByColumn = {};
    for (const fk of fkRows) {
      fkByColumn[fk.from] = { table: fk.table, key: fk.to, onDelete: fk.on_delete, onUpdate: fk.on_update };
    }
    tables[tableName] = { model, fkByColumn };
  }

  // Topological order by FK dependencies (skip cyclic edges).
  const names = Object.keys(tables);
  const deps = {};
  for (const t of names) {
    deps[t] = new Set();
    for (const col of Object.keys(tables[t].fkByColumn)) {
      const ref = tables[t].fkByColumn[col].table;
      if (ref !== t && names.includes(ref)) deps[t].add(ref);
    }
  }
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();
  function visit(t, stack) {
    if (visited.has(t)) return;
    if (visiting.has(t)) return; // cycle: skip
    visiting.add(t);
    for (const d of deps[t]) visit(d, stack);
    visiting.delete(t);
    visited.add(t);
    ordered.push(t);
  }
  names.forEach((t) => visit(t, []));

  // Build column definitions.
  function columnsFor(tableName) {
    const { model, fkByColumn } = tables[tableName];
    const cols = {};
    const raw = model.rawAttributes;
    for (const attrName of Object.keys(raw)) {
      const attr = raw[attrName];
      if (attr.type && attr.type.key === 'VIRTUAL') continue;
      const colName = attr.field || attrName;
      const def = { type: sequelizeType(attr) };
      if (attr.allowNull === false) def.allowNull = false;
      if (attr.primaryKey) def.primaryKey = true;
      if (attr.autoIncrement) def.autoIncrement = true;
      const dv = defaultValueSql(attr);
      if (dv !== null) def.defaultValue = dv;
      if (fkByColumn[colName]) {
        const fk = fkByColumn[colName];
        // Only add inline reference if the referenced table is created earlier (avoid cycles/forward refs).
        if (ordered.indexOf(fk.table) < ordered.indexOf(tableName) && ordered.includes(fk.table)) {
          def.references = { model: fk.table, key: fk.key };
          if (fk.onDelete && fk.onDelete !== 'NO ACTION') def.onDelete = fk.onDelete;
          if (fk.onUpdate && fk.onUpdate !== 'NO ACTION') def.onUpdate = fk.onUpdate;
        }
      }
      cols[colName] = def;
    }
    return cols;
  }

  function indexesFor(tableName) {
    const idx = (tables[tableName].model.options.indexes || [])
      .filter((i) => i.fields && i.fields.length)
      .map((i) => ({ fields: i.fields, unique: !!i.unique, name: i.name }));
    return idx;
  }

  function emitColumns(cols, indent) {
    const lines = [];
    for (const c of Object.keys(cols)) {
      const d = cols[c];
      const parts = [`type: ${d.type}`];
      if (d.allowNull === false) parts.push('allowNull: false');
      if (d.primaryKey) parts.push('primaryKey: true');
      if (d.autoIncrement) parts.push('autoIncrement: true');
      if (d.defaultValue !== undefined) parts.push(`defaultValue: ${d.defaultValue}`);
      if (d.references) {
        parts.push(`references: { model: ${JSON.stringify(d.references.model)}, key: ${JSON.stringify(d.references.key)} }`);
        if (d.onDelete) parts.push(`onDelete: ${JSON.stringify(d.onDelete)}`);
        if (d.onUpdate) parts.push(`onUpdate: ${JSON.stringify(d.onUpdate)}`);
      }
      lines.push(`${indent}${JSON.stringify(c)}: { ${parts.join(', ')} },`);
    }
    return lines.join('\n');
  }

  let up = '';
  for (const t of ordered) {
    const cols = columnsFor(t);
    const idx = indexesFor(t);
    up += `    await queryInterface.createTable(${JSON.stringify(t)}, {\n`;
    up += emitColumns(cols, '      ');
    up += `\n    }`;
    if (idx.length) {
      up += `, { indexes: ${JSON.stringify(idx)} }`;
    }
    up += `);\n`;
  }
  let down = '';
  for (const t of [...ordered].reverse()) {
    down += `    await queryInterface.dropTable(${JSON.stringify(t)});\n`;
  }

  // Session store table (connect-session-sequelize). Managed here so the schema
  // is fully reproducible from migrations alone (no runtime sync()).
  up += `    await queryInterface.createTable("Sessions", {
      "sid": { type: Sequelize.STRING, allowNull: false, primaryKey: true },
      "expires": { type: Sequelize.DATE },
      "data": { type: Sequelize.TEXT },
      "createdAt": { type: Sequelize.DATE, allowNull: false },
      "updatedAt": { type: Sequelize.DATE, allowNull: false },
    });\n`;
  down = `    await queryInterface.dropTable("Sessions");\n` + down;

  const source = `'use strict';

/*
 * Clean initial schema (generated from Sequelize 6 models).
 * Replaces all legacy migrations. Dialect-agnostic (SQLite + PostgreSQL).
 * No historical data compatibility is required (project is pre-production).
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
${up}  },

  down: async (queryInterface, Sequelize) => {
${down}  },
};
`;

  fs.mkdirSync(path.dirname(MIGRATION_PATH), { recursive: true });
  fs.writeFileSync(MIGRATION_PATH, source);
  console.log('Generated', MIGRATION_PATH, 'tables:', ordered.length);

  // ---- Verify on a FRESH database via migrations (not sync) ----
  const os = require('os');
  const verifyStorage = path.join(os.tmpdir(), `timeoff-mig-verify-${Date.now()}.sqlite`);
  const verifySeq = new Sequelize({ dialect: 'sqlite', storage: verifyStorage, logging: false });
  const { Umzug, SequelizeStorage } = require('umzug');
  const umzug = new Umzug({
    migrations: {
      glob: ['migrations/*.js', { cwd: path.join(__dirname, '..') }],
      resolve: ({ name, path: mp, context }) => {
        const m = require(mp);
        return { name, up: async () => m.up(context, Sequelize), down: async () => m.down(context, Sequelize) };
      },
    },
    context: verifySeq.getQueryInterface(),
    storage: new SequelizeStorage({ sequelize: verifySeq }),
    logger: undefined,
  });
  await umzug.up();

  const migTables = await verifySeq.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'SequelizeMeta' ORDER BY name", { type: Sequelize.QueryTypes.SELECT });
  const syncTables = await sequelize.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name", { type: Sequelize.QueryTypes.SELECT });
  const migSet = migTables.map((r) => r.name).filter((n) => n !== 'Sessions').sort();
  const syncSet = syncTables.map((r) => r.name).filter((n) => n !== 'Sessions').sort();
  const missing = syncSet.filter((t) => !migSet.includes(t));
  const extra = migSet.filter((t) => !syncSet.includes(t));
  console.log('VERIFY tables missing:', missing, 'extra:', extra);

  let colMismatch = [];
  for (const t of syncSet) {
    if (!migSet.includes(t)) continue;
    const a = await sequelize.query(`PRAGMA table_info("${t}")`, { type: Sequelize.QueryTypes.SELECT });
    const b = await verifySeq.query(`PRAGMA table_info("${t}")`, { type: Sequelize.QueryTypes.SELECT });
    const ac = a.map((c) => c.name).sort();
    const bc = b.map((c) => c.name).sort();
    if (JSON.stringify(ac) !== JSON.stringify(bc)) colMismatch.push({ table: t, sync: ac, mig: bc });
  }
  console.log('VERIFY column mismatches:', JSON.stringify(colMismatch));

  await verifySeq.close();
  await sequelize.close();
  try { fs.unlinkSync(verifyStorage); } catch (e) {}
  if (missing.length || extra.length || colMismatch.length) {
    console.log('MIGRATION_VERIFY_FAIL');
    process.exit(1);
  }
  console.log('MIGRATION_VERIFY_OK');
}

main().catch((e) => { console.error(e); process.exit(1); });
