'use strict';

// CLI: apply pending migrations then exit. Used by `npm run db:migrate`.
require('../lib/promise-shim');

const db = require('../lib/model/db');
const { runMigrations } = require('../lib/migrate');

(async () => {
  const { applied } = await runMigrations(db.sequelize);
  console.log(`Migrations applied: ${applied.length ? applied.map((m) => m.name).join(', ') : '(none pending)'}`);
  await db.sequelize.close();
  process.exit(0);
})().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
