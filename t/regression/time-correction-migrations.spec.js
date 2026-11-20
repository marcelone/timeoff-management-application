'use strict';

const assert = require('assert');
const { Sequelize } = require('sequelize');
const { runMigrations } = require('../../lib/migrate');
const block3 = require('../../migrations/20260106000000-time-corrections');
const selfApproval = require('../../migrations/20260107000000-time-corrections-self-approval');

describe('time correction migrations — historical SQLite data', function () {
  it('round-trips with historical clock events and preserves foreign keys and indexes', async () => {
    const sequelize = new Sequelize('sqlite::memory:', { logging: false });
    try {
      await sequelize.query('PRAGMA foreign_keys = ON');
      await runMigrations(sequelize);
      const qi = sequelize.getQueryInterface();
      const createdAt = new Date('2026-01-01T09:00:00Z');
      await qi.bulkInsert('Companies', [{ id: 1, name: 'Audit', country: 'es', start_of_new_year: 1,
        integration_api_token: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', createdAt, updatedAt: createdAt }]);
      await qi.bulkInsert('Users', [{ id: 1, email: 'audit@example.com', password: 'unused', name: 'A', lastname: 'B',
        companyId: 1, start_date: createdAt, createdAt, updatedAt: createdAt }]);
      await qi.bulkInsert('time_entries', [{ id: 1, company_id: 1, user_id: 1, modality: 'office', status: 'closed',
        started_at: createdAt, ended_at: new Date('2026-01-01T17:00:00Z'), created_at: createdAt, updated_at: createdAt }]);
      await qi.bulkInsert('time_entry_events', [{ id: 1, company_id: 1, user_id: 1, time_entry_id: 1,
        type: 'in', source: 'direct', occurred_at: createdAt, created_at: createdAt }]);
      await selfApproval.down(qi);
      await block3.down(qi);
      await block3.up(qi, Sequelize);
      await selfApproval.up(qi, Sequelize);
      const [events] = await sequelize.query('SELECT type, source FROM time_entry_events WHERE id = 1');
      assert.deepStrictEqual(events, [{ type: 'in', source: 'direct' }]);
      const [violations] = await sequelize.query('PRAGMA foreign_key_check');
      assert.deepStrictEqual(violations, []);
      const [indexes] = await sequelize.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('time_entries_one_open_per_user', 'time_corrections_one_pending_per_target')");
      assert.strictEqual(indexes.length, 2);
    } finally { await sequelize.close(); }
  });
});
