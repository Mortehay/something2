const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withAdvisoryLock } = require('./advisoryLock.js');

// Shared by every seed_sync DB test file. node --test runs files in parallel and
// export rewrites a whole group's baselines, so all of them take this one key.
const SEED_SYNC_TEST_LOCK = 632633001;

function withSeedSyncLock(pool, fn, opts) {
  return withAdvisoryLock(pool, SEED_SYNC_TEST_LOCK, fn, { waitMs: 30000, ...opts });
}

function makeTempSyncDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'seed-sync-'));
}

// Delete sx_ fixture rows and any baseline hash whose row no longer exists.
async function cleanupSx(pool) {
  await pool.query("DELETE FROM quests WHERE key LIKE 'sx\\_%'");
  await pool.query("DELETE FROM tile_types WHERE name LIKE 'sx\\_%'");
  await pool.query("DELETE FROM ai_providers WHERE name LIKE 'sx\\_%'");
  await pool.query(`DELETE FROM seed_row_hashes h WHERE NOT EXISTS (
    SELECT 1 FROM quests q WHERE q.sync_uuid = h.sync_uuid
    UNION ALL SELECT 1 FROM tile_types t WHERE t.sync_uuid = h.sync_uuid
    UNION ALL SELECT 1 FROM ai_providers a WHERE a.sync_uuid = h.sync_uuid)`);
}

module.exports = { SEED_SYNC_TEST_LOCK, withSeedSyncLock, makeTempSyncDir, cleanupSx };
