const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withAdvisoryLock } = require('./advisoryLock.js');

// Shared by every seed_sync DB test file. node --test runs files in parallel and
// export rewrites a whole group's baselines, so all of them take this one key.
const SEED_SYNC_TEST_LOCK = 632633001;
// seed_sync_apply_db.test.js deletes every seed run above a per-test id
// watermark. That is only safe because EVERY test that writes seed runs holds
// SEED_SYNC_TEST_LOCK while doing so -- route tests (Task 6) that seed must
// take it too, or their runs can be deleted mid-test.

function withSeedSyncLock(pool, fn, opts) {
  return withAdvisoryLock(pool, SEED_SYNC_TEST_LOCK, fn, { waitMs: 30000, ...opts });
}

function makeTempSyncDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'seed-sync-'));
}

// Delete sx_ fixture rows and exactly their baseline hashes. Orphaned baselines
// of other rows are legitimate state (deletion detection) and are left alone.
// Test-only groups (registry _withTestGroups) are named sx_*: their baselines
// and runs go too. Child rows without a name of their own (drops, abilities,
// loadouts, edges, chest_loot) are sx_ through an sx_ parent and go with it
// (ON DELETE CASCADE). Children before parents: entity_types ->
// creature_behaviors (NO ACTION), item_types.ammo_type_id is ON DELETE
// RESTRICT so it is cleared first, creature_behavior_skills.skill_id is
// RESTRICT (behaviors before skills).
async function cleanupSx(pool) {
  const { rows } = await pool.query(`
    SELECT sync_uuid FROM quests WHERE key LIKE 'sx\\_%'
    UNION ALL SELECT sync_uuid FROM tile_types WHERE name LIKE 'sx\\_%'
    UNION ALL SELECT sync_uuid FROM ai_providers WHERE name LIKE 'sx\\_%'
    UNION ALL SELECT sync_uuid FROM entity_types WHERE name LIKE 'sx\\_%'
    UNION ALL SELECT sync_uuid FROM item_types WHERE name LIKE 'sx\\_%'
    UNION ALL SELECT sync_uuid FROM creature_behaviors WHERE name LIKE 'sx\\_%'
    UNION ALL SELECT sync_uuid FROM aura_effects WHERE name LIKE 'sx\\_%'
    UNION ALL SELECT sync_uuid FROM creature_skills WHERE name LIKE 'sx\\_%'
    UNION ALL SELECT sync_uuid FROM vfx_effects WHERE name LIKE 'sx\\_%'
    UNION ALL SELECT sync_uuid FROM affix_types WHERE key LIKE 'sx\\_%'
    UNION ALL SELECT sync_uuid FROM biomes WHERE name LIKE 'sx\\_%'
    UNION ALL SELECT sync_uuid FROM passive_nodes WHERE key LIKE 'sx\\_%'
    UNION ALL SELECT e.sync_uuid FROM passive_edges e JOIN passive_nodes n ON n.id IN (e.a_id, e.b_id)
      WHERE n.key LIKE 'sx\\_%'
    UNION ALL SELECT c.sync_uuid FROM creature_abilities c JOIN creature_behaviors b ON b.id = c.behavior_id
      WHERE b.name LIKE 'sx\\_%'
    UNION ALL SELECT c.sync_uuid FROM creature_behavior_skills c
      JOIN creature_behaviors b ON b.id = c.behavior_id JOIN creature_skills s ON s.id = c.skill_id
      WHERE b.name LIKE 'sx\\_%' OR s.name LIKE 'sx\\_%'
    UNION ALL SELECT c.sync_uuid FROM behavior_drops c
      JOIN creature_behaviors b ON b.id = c.behavior_id JOIN item_types i ON i.id = c.item_type_id
      WHERE b.name LIKE 'sx\\_%' OR i.name LIKE 'sx\\_%'
    UNION ALL SELECT c.sync_uuid FROM chest_loot c JOIN item_types i ON i.id = c.item_type_id WHERE i.name LIKE 'sx\\_%'
    UNION ALL SELECT c.sync_uuid FROM creature_drops c
      JOIN entity_types e ON e.id = c.entity_type_id JOIN item_types i ON i.id = c.item_type_id
      WHERE e.name LIKE 'sx\\_%' OR i.name LIKE 'sx\\_%'
    UNION ALL SELECT c.sync_uuid FROM class_loadouts c
      JOIN entity_types e ON e.id = c.entity_type_id JOIN item_types i ON i.id = c.item_type_id
      LEFT JOIN item_types s ON s.id = c.socket_into_item_type_id
      WHERE e.name LIKE 'sx\\_%' OR i.name LIKE 'sx\\_%' OR s.name LIKE 'sx\\_%'`);
  await pool.query("DELETE FROM quests WHERE key LIKE 'sx\\_%'");
  await pool.query("DELETE FROM tile_types WHERE name LIKE 'sx\\_%'");
  await pool.query("DELETE FROM ai_providers WHERE name LIKE 'sx\\_%'");
  await pool.query("DELETE FROM entity_types WHERE name LIKE 'sx\\_%'");
  await pool.query("UPDATE item_types SET ammo_type_id = NULL WHERE name LIKE 'sx\\_%' AND ammo_type_id IS NOT NULL");
  await pool.query("DELETE FROM item_types WHERE name LIKE 'sx\\_%'");
  await pool.query("DELETE FROM creature_behaviors WHERE name LIKE 'sx\\_%'");
  await pool.query("DELETE FROM aura_effects WHERE name LIKE 'sx\\_%'");
  await pool.query("DELETE FROM creature_skills WHERE name LIKE 'sx\\_%'");
  await pool.query("DELETE FROM vfx_effects WHERE name LIKE 'sx\\_%'");
  await pool.query("DELETE FROM affix_types WHERE key LIKE 'sx\\_%'");
  await pool.query("DELETE FROM biomes WHERE name LIKE 'sx\\_%'");
  await pool.query("DELETE FROM passive_nodes WHERE key LIKE 'sx\\_%'");
  if (rows.length) {
    await pool.query('DELETE FROM seed_row_hashes WHERE sync_uuid = ANY($1::uuid[])', [rows.map((r) => r.sync_uuid)]);
  }
  await pool.query("DELETE FROM seed_row_hashes WHERE group_id LIKE 'sx\\_%'");
  await pool.query("DELETE FROM seed_export_runs WHERE group_id LIKE 'sx\\_%'");
}

module.exports = { SEED_SYNC_TEST_LOCK, withSeedSyncLock, makeTempSyncDir, cleanupSx };
