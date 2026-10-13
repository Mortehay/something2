// backend/tests/boss_loot_award_db.test.js
// SOMET-611 (S10, spec §3.7/§7): "dungeon End kill yields loot_rolls items +
// a chest" (the spec's own testing requirement, verbatim), and the matching
// Elite case for the "no chest for Elite" tier default -- against the REAL
// server wiring (server.js's own default `dungeonBosses.onKilled`, not a
// test-supplied stub, unlike dungeon_boss_live_db.test.js's kills-array
// fixture), the real catalog (The Bone Regent / Ossuary Warden, seeded by
// 1714440701000_seed_dungeon_boss_entities.js, each already carrying its own
// one creature_drops row per dungeon_boss_entities_seed_db.test.js), and a
// real world_chests/world_items round trip.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Pool } = require('pg');
const { attachAuthority } = require('../src/authority/server.js');
const { withFixtureWorld } = require('./helpers/fixtureWorld');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL' : false;

test('a dungeon_end kill (The Bone Regent) spawns loot_rolls extra items plus its own drop row, and a chest', { skip }, async () => {
  const pool = new Pool({ connectionString: url, max: 4 });
  const server = http.createServer();
  // No onDungeonBossKilled override: this exercises the REAL default wired
  // in server.js (awardDungeonBossLoot), the whole point of this test over
  // dungeon_boss_live_db.test.js's stubbed one.
  const srv = attachAuthority(server, pool, {
    jwtSecret: 'test-secret', creatureSweepMs: 1e9, itemSweepMs: 1e9, heartbeatMs: 1e9, flushMs: 1e9,
  });
  try {
    await withFixtureWorld(pool, async (worldId) => {
      await pool.query(
        `UPDATE worlds SET biomes = '["Deep Forest"]'::jsonb, level_min = 41, level_max = 50,
                dungeon_boss = $2::jsonb WHERE id = $1`,
        [worldId, JSON.stringify({ entity: 'The Bone Regent', x: 4850, y: 4850, respawn_s: 600 })],
      );
      const entry = await srv._loadWorld(worldId);
      const id = 'boss:' + worldId;
      const before = await pool.query('SELECT count(*)::int AS n FROM world_items WHERE world_id = $1', [worldId]);
      assert.equal(before.rows[0].n, 0, 'nothing on the ground before the kill');

      entry.world.creatures._removeKilled(entry.world.creatures.get(id));
      await srv._onCreatureDeath(entry, id, 'u1');
      // awardDungeonBossLoot is fire-and-forget from dungeonBosses.onDeath
      // (Promise.resolve(...).catch(...)); give its awaits a tick.
      await new Promise((r) => setTimeout(r, 200));

      // Excludes the gold pile explicitly (joined out by name, not by
      // item_level): world_items.item_level is NOT NULL DEFAULT 1, and
      // spawnBossGold's INSERT (deliberately) never sets it, so a gold row
      // reads back as item_level 1 -- indistinguishable from a real rolled
      // item by level alone.
      const items = await pool.query(
        `SELECT wi.item_type_id, wi.rarity, wi.item_level FROM world_items wi
           JOIN item_types it ON it.id = wi.item_type_id
          WHERE wi.world_id = $1 AND it.name != 'gold'`,
        [worldId],
      );
      // dungeon_end default is 4 rolls (TIER_LOOT_DEFAULTS.dungeon_end), PLUS
      // The Bone Regent's own one creature_drops row ('long sword',
      // dungeon_boss_entities_seed_db.test.js) -- not a replacement for it.
      assert.ok(items.rows.length >= 4, `expected at least 4 dropped items, got ${items.rows.length}`);
      // Item level = boss level (End at [41,50] = level 50, per
      // dungeonBossLevel), not a flat constant.
      for (const r of items.rows) assert.equal(r.item_level, 50);

      const chests = await pool.query(
        'SELECT kind, guard_entity_type_id, guard_level, state FROM world_chests WHERE world_id = $1', [worldId],
      );
      assert.equal(chests.rows.length, 1, 'dungeon_end defaults to a chest');
      assert.equal(chests.rows[0].kind, 'vault');
      assert.equal(chests.rows[0].state, 'unlocked', 'no live guard to kill first');
      assert.equal(chests.rows[0].guard_level, 50);
      const bossType = await pool.query("SELECT id FROM entity_types WHERE name = 'The Bone Regent'");
      assert.equal(chests.rows[0].guard_entity_type_id, bossType.rows[0].id,
        'the defeated boss itself is named as the chest\'s guard entity type');

      srv.evictWorld(worldId);
    }, { prefix: 'zzS10dungeonEnd' });
  } finally {
    srv.close();
    await pool.end();
  }
});

test('a dungeon_elite kill (Ossuary Warden) spawns loot but NO chest (tier default)', { skip }, async () => {
  const pool = new Pool({ connectionString: url, max: 4 });
  const server = http.createServer();
  const srv = attachAuthority(server, pool, {
    jwtSecret: 'test-secret', creatureSweepMs: 1e9, itemSweepMs: 1e9, heartbeatMs: 1e9, flushMs: 1e9,
  });
  try {
    await withFixtureWorld(pool, async (worldId) => {
      await pool.query(
        `UPDATE worlds SET biomes = '["Deep Forest"]'::jsonb, level_min = 41, level_max = 50,
                dungeon_boss = $2::jsonb WHERE id = $1`,
        [worldId, JSON.stringify({ entity: 'Ossuary Warden', x: 4850, y: 4850, respawn_s: 600 })],
      );
      const entry = await srv._loadWorld(worldId);
      const id = 'boss:' + worldId;

      entry.world.creatures._removeKilled(entry.world.creatures.get(id));
      await srv._onCreatureDeath(entry, id, 'u1');
      await new Promise((r) => setTimeout(r, 200));

      const items = await pool.query('SELECT item_type_id FROM world_items WHERE world_id = $1', [worldId]);
      // dungeon_elite default is 2 rolls, plus Ossuary Warden's own one
      // creature_drops row ('short sword').
      assert.ok(items.rows.length >= 2, `expected at least 2 dropped items, got ${items.rows.length}`);

      const chests = await pool.query('SELECT 1 FROM world_chests WHERE world_id = $1', [worldId]);
      assert.equal(chests.rows.length, 0, 'dungeon_elite defaults to no chest');

      srv.evictWorld(worldId);
    }, { prefix: 'zzS10dungeonElite' });
  } finally {
    srv.close();
    await pool.end();
  }
});

// A per-boss loot_chest override: Ossuary Warden explicitly given a chest,
// beating the dungeon_elite tier default of none. Exercises
// resolveLootProfile's override path (not just TIER_LOOT_DEFAULTS) against a
// real row, and reverts the override afterward (this creature's row is
// shared by every test file in the suite).
// World boss: "3 per damaging participant" + the pre-existing top-3/gold/
// Victor's Boon (kept), and the chest insert fix (it used to omit the
// NOT NULL guard_entity_type_id and fail silently -- see worldBoss.js's own
// comment at the INSERT this replaced).
test('a world boss kill with 2 damaging participants spawns per-participant loot AND a working chest', { skip }, async () => {
  const pool = new Pool({ connectionString: url, max: 4 });
  const server = http.createServer();
  const srv = attachAuthority(server, pool, {
    jwtSecret: 'test-secret', creatureSweepMs: 1e9, itemSweepMs: 1e9, heartbeatMs: 1e9, flushMs: 1e9,
  });
  try {
    await withFixtureWorld(pool, async (worldId) => {
      const entry = await srv._loadWorld(worldId);
      const worlds = new Map([[worldId, entry]]);
      const wbm = srv._worldBossManager;
      const spawned = wbm.forceSpawn(Date.now(), worlds, { bossName: 'Abyssor, the Voidreaver' }, () => {});
      assert.equal(spawned, true, 'the real catalog has Abyssor, the Voidreaver (SOMET-603 seed)');
      const c = entry.world.creatures.get(wbm.bossCreatureId);
      assert.ok(c, 'the boss is live in the sim');
      // Two participants, neither of them the killer below -- the top3
      // legendary path and the NEW per-participant loot path both read this
      // same map, so this one fixture exercises both at once.
      c._playerDamage = new Map([['u1', 9000], ['u2', 1000]]);
      wbm.currentBoss._playerDamage = c._playerDamage;

      const before = await pool.query('SELECT count(*)::int AS n FROM world_items WHERE world_id = $1', [worldId]);

      entry.world.creatures._removeKilled(c);
      await srv._onCreatureDeath(entry, wbm.bossCreatureId, 'u1');
      await new Promise((r) => setTimeout(r, 300));

      const items = await pool.query(
        `SELECT wi.item_level FROM world_items wi JOIN item_types it ON it.id = wi.item_type_id
          WHERE wi.world_id = $1 AND it.name != 'gold'`,
        [worldId],
      );
      const after = items.rows.length;
      // >= 2 participants * 3 rolls (TIER_LOOT_DEFAULTS.world) + the pre-
      // existing top-3 legendary drops (2 recipients here, u1 and u2) = >= 8.
      // Not an exact count: a world boss entity_types row carries no
      // creature_drops of its own (unlike a dungeon boss), so this is purely
      // the two mechanisms this test names, nothing else to account for.
      assert.ok(after - before.rows[0].n >= 8, `expected at least 8 non-gold items, got ${after - before.rows[0].n}`);
      for (const r of items.rows) assert.equal(r.item_level, 100, 'item level is WORLD_BOSS_LEVEL, not a per-tier value');

      const chests = await pool.query(
        'SELECT kind, guard_entity_type_id, guard_level, state FROM world_chests WHERE world_id = $1', [worldId],
      );
      assert.equal(chests.rows.length, 1, 'world tier defaults to a chest, and the insert no longer fails silently');
      assert.equal(chests.rows[0].state, 'unlocked');
      const bossType = await pool.query("SELECT id FROM entity_types WHERE name = 'Abyssor, the Voidreaver'");
      assert.equal(chests.rows[0].guard_entity_type_id, bossType.rows[0].id,
        'the previously-omitted NOT NULL column is now populated with the defeated boss\'s own type');

      srv.evictWorld(worldId);
    }, { prefix: 'zzS10worldBoss' });
  } finally {
    srv.close();
    await pool.end();
  }
});

test('a per-boss loot_chest override beats the tier default', { skip }, async () => {
  const pool = new Pool({ connectionString: url, max: 4 });
  const server = http.createServer();
  const srv = attachAuthority(server, pool, {
    jwtSecret: 'test-secret', creatureSweepMs: 1e9, itemSweepMs: 1e9, heartbeatMs: 1e9, flushMs: 1e9,
  });
  try {
    await pool.query("UPDATE entity_types SET loot_chest = true WHERE name = 'Ossuary Warden'");
    await withFixtureWorld(pool, async (worldId) => {
      await pool.query(
        `UPDATE worlds SET biomes = '["Deep Forest"]'::jsonb, level_min = 41, level_max = 50,
                dungeon_boss = $2::jsonb WHERE id = $1`,
        [worldId, JSON.stringify({ entity: 'Ossuary Warden', x: 4850, y: 4850, respawn_s: 600 })],
      );
      const entry = await srv._loadWorld(worldId);
      const id = 'boss:' + worldId;

      entry.world.creatures._removeKilled(entry.world.creatures.get(id));
      await srv._onCreatureDeath(entry, id, 'u1');
      await new Promise((r) => setTimeout(r, 200));

      const chests = await pool.query('SELECT 1 FROM world_chests WHERE world_id = $1', [worldId]);
      assert.equal(chests.rows.length, 1, 'the per-boss override wins over the dungeon_elite tier default');

      srv.evictWorld(worldId);
    }, { prefix: 'zzS10override' });
  } finally {
    await pool.query("UPDATE entity_types SET loot_chest = NULL WHERE name = 'Ossuary Warden'");
    srv.close();
    await pool.end();
  }
});
