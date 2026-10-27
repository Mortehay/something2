// backend/tests/boss_loot_award_db.test.js
// SOMET-611 (S10, spec §3.7/§7): "dungeon End kill yields loot_rolls items +
// a chest" (the spec's own testing requirement, verbatim), and the matching
// Elite case for the "no chest for Elite" tier default -- against the REAL
// server wiring (server.js's own default `dungeonBosses.onKilled`, not a
// test-supplied stub, unlike dungeon_boss_live_db.test.js's kills-array
// fixture), the real catalog (The Bone Regent / Ossuary Warden, seeded by
// 1714440701000_seed_dungeon_boss_entities.js, each carrying its own
// creature_drops row per dungeon_boss_entities_seed_db.test.js), and a real
// world_chests/world_items round trip.
//
// Rework: every server here gets a CONSTANT rng (RNG_VALUE), so item counts
// are exact rather than ">= N" -- a ">= 4" let "own drop row + 3 rolls" pass
// for a boss that should have rolled 4 extras. The expected own-drop count
// is computed from the entity's real drop rows through the pre-existing
// rollDrops (not code under test), with that same constant rng.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Pool } = require('pg');
const { attachAuthority } = require('../src/authority/server.js');
const { rollDrops } = require('../src/authority/loot.js');
const { RARITIES } = require('../src/authority/rarity.js');
const { shortenBossChestExpiry } = require('../src/authority/bossLoot.js');
const { withFixtureWorld } = require('./helpers/fixtureWorld');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL' : false;

// Below every seeded boss drop row's chance (0.2), so each own row rolls
// exactly once at its min_qty -- deterministic, and non-zero, so "rolled
// once per kill" is distinguishable from "never" and from "once per
// participant".
const RNG_VALUE = 0.1;
const rng = () => RNG_VALUE;

function makeServer(pool) {
  const server = http.createServer();
  return attachAuthority(server, pool, {
    jwtSecret: 'test-secret', creatureSweepMs: 1e9, itemSweepMs: 1e9, heartbeatMs: 1e9, flushMs: 1e9, rng,
  });
}

async function ownDropCount(pool, entityName) {
  const et = await pool.query('SELECT id, behavior_id FROM entity_types WHERE name = $1', [entityName]);
  const { id, behavior_id: behaviorId } = et.rows[0];
  const dr = await pool.query('SELECT chance, min_qty, max_qty, item_type_id FROM creature_drops WHERE entity_type_id = $1', [id]);
  const br = behaviorId == null ? { rows: [] }
    : await pool.query('SELECT chance, min_qty, max_qty, item_type_id FROM behavior_drops WHERE behavior_id = $1', [behaviorId]);
  return rollDrops(dr.rows, rng).length + rollDrops(br.rows, rng).length;
}

// Non-gold items and the gold pile, separated by item name: world_items.
// item_level is NOT NULL DEFAULT 1 and spawnBossGold never sets it, so a
// gold row is indistinguishable from a real item by level alone.
async function groundLoot(pool, worldId) {
  const r = await pool.query(
    `SELECT it.name, wi.rarity, wi.item_level, wi.quantity FROM world_items wi
       JOIN item_types it ON it.id = wi.item_type_id WHERE wi.world_id = $1`,
    [worldId],
  );
  return {
    items: r.rows.filter((x) => x.name !== 'gold'),
    gold: r.rows.filter((x) => x.name === 'gold'),
  };
}

async function placeDungeonBoss(pool, srv, worldId, entity) {
  await pool.query(
    `UPDATE worlds SET biomes = '["Deep Forest"]'::jsonb, level_min = 41, level_max = 50,
            dungeon_boss = $2::jsonb WHERE id = $1`,
    [worldId, JSON.stringify({ entity, x: 4850, y: 4850, respawn_s: 600 })],
  );
  return srv._loadWorld(worldId);
}

async function killDungeonBoss(srv, entry, worldId) {
  const id = 'boss:' + worldId;
  entry.world.creatures._removeKilled(entry.world.creatures.get(id));
  await srv._onCreatureDeath(entry, id, 'u1');
  // awardDungeonBossLoot is fire-and-forget from dungeonBosses.onDeath
  // (Promise.resolve(...).catch(...)); poll for the chest/items rather than
  // a fixed sleep.
}

async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

const atLeast = (rarity, floor) => RARITIES.indexOf(rarity) >= RARITIES.indexOf(floor);

test('a dungeon_end kill (The Bone Regent): exactly 4 extra rolls + own drops, floor yellow, own gold range, a transient chest', { skip }, async () => {
  const pool = new Pool({ connectionString: url, max: 4 });
  const srv = makeServer(pool);
  try {
    const own = await ownDropCount(pool, 'The Bone Regent');
    assert.ok(own >= 1, 'fixture premise: The Bone Regent has its own drop row that rolls at this rng');
    await withFixtureWorld(pool, async (worldId) => {
      const entry = await placeDungeonBoss(pool, srv, worldId, 'The Bone Regent');
      const before = await groundLoot(pool, worldId);
      assert.equal(before.items.length + before.gold.length, 0, 'nothing on the ground before the kill');

      await killDungeonBoss(srv, entry, worldId);
      await waitFor(async () => (await pool.query('SELECT 1 FROM world_chests WHERE world_id = $1', [worldId])).rowCount > 0);

      const { items, gold } = await groundLoot(pool, worldId);
      assert.equal(items.length, 4 + own, `4 dungeon_end rolls + ${own} own drop(s)`);
      for (const r of items) {
        assert.equal(r.item_level, 50, 'item level = boss level (End at [41,50] = 50)');
        assert.ok(atLeast(r.rarity, 'yellow'), `${r.name} rolled ${r.rarity}, below the dungeon_end floor`);
      }
      // Spec §3.1: the entity's own gold_min/gold_max (20..40 seeded), not
      // the 100..600 boss-generic fallback.
      assert.equal(gold.length, 1);
      assert.ok(gold[0].quantity >= 20 && gold[0].quantity <= 40, `gold ${gold[0].quantity} outside The Bone Regent's 20..40`);

      const chests = await pool.query(
        `SELECT id, kind, guard_entity_type_id, guard_level, state,
                extract(epoch FROM expires_at - now()) AS ttl_s
           FROM world_chests WHERE world_id = $1`, [worldId],
      );
      assert.equal(chests.rows.length, 1, 'dungeon_end defaults to a chest');
      const c = chests.rows[0];
      assert.equal(c.kind, 'vault');
      assert.equal(c.state, 'unlocked', 'no live guard to kill first');
      assert.equal(c.guard_level, 50);
      const bossType = await pool.query("SELECT id FROM entity_types WHERE name = 'The Bone Regent'");
      assert.equal(c.guard_entity_type_id, bossType.rows[0].id);
      assert.ok(c.ttl_s > 9 * 60 && c.ttl_s <= 10 * 60 + 5, `boss chest expires ~10 min out, got ${c.ttl_s}s`);
      const live = entry.chests.find((x) => x.id === c.id);
      assert.ok(live && live.expiresAt != null, 'the in-memory chest carries the deadline the openchest handler reads');

      srv.evictWorld(worldId);
    }, { prefix: 'zzS10dungeonEnd' });
  } finally {
    srv.close();
    await pool.end();
  }
});

// Finding 3/4 of the 2026-10-15 validation: dungeon-boss chests stacked one
// permanent row per respawn, and the world-boss chest's despawn relied on an
// in-memory flag nothing set. Both now run off world_chests.expires_at.
test('a boss chest: opening shortens its deadline to ~30s, and the sweep purges it from DB and entry.chests', { skip }, async () => {
  const pool = new Pool({ connectionString: url, max: 4 });
  const srv = makeServer(pool);
  try {
    await withFixtureWorld(pool, async (worldId) => {
      const entry = await placeDungeonBoss(pool, srv, worldId, 'The Bone Regent');
      // A permanent authored chest in the same world must survive the purge.
      const bossType = await pool.query("SELECT id FROM entity_types WHERE name = 'The Bone Regent'");
      const perm = await pool.query(
        `INSERT INTO world_chests (world_id, x, y, kind, guard_entity_type_id, guard_level, guard_creature_ids, state)
         VALUES ($1, 10, 10, 'vault', $2, 1, '[]'::jsonb, 'opened') RETURNING id`,
        [worldId, bossType.rows[0].id],
      );

      await killDungeonBoss(srv, entry, worldId);
      await waitFor(() => entry.chests.some((x) => x.expiresAt != null));
      const chest = entry.chests.find((x) => x.expiresAt != null);
      assert.ok(chest, 'boss chest spawned with a deadline');

      await shortenBossChestExpiry(pool, chest);
      const after = await pool.query('SELECT extract(epoch FROM expires_at - now()) AS s FROM world_chests WHERE id = $1', [chest.id]);
      assert.ok(after.rows[0].s <= 31 && after.rows[0].s > 0, `opened chest deadline ~30s, got ${after.rows[0].s}s`);

      await pool.query("UPDATE world_chests SET expires_at = now() - interval '1 second' WHERE id = $1", [chest.id]);
      await srv._purgeExpiredChests();
      const rows = await pool.query('SELECT id FROM world_chests WHERE world_id = $1', [worldId]);
      assert.deepEqual(rows.rows.map((r) => r.id), [perm.rows[0].id], 'only the expired boss chest was deleted');
      assert.equal(entry.chests.some((x) => x.id === chest.id), false, 'and it left the live world too');

      srv.evictWorld(worldId);
    }, { prefix: 'zzS10chestExpiry' });
  } finally {
    srv.close();
    await pool.end();
  }
});

test('a dungeon_elite kill (Ossuary Warden): exactly 2 rolls + own drops, floor blue, NO chest (tier default)', { skip }, async () => {
  const pool = new Pool({ connectionString: url, max: 4 });
  const srv = makeServer(pool);
  try {
    const own = await ownDropCount(pool, 'Ossuary Warden');
    await withFixtureWorld(pool, async (worldId) => {
      const entry = await placeDungeonBoss(pool, srv, worldId, 'Ossuary Warden');
      await killDungeonBoss(srv, entry, worldId);
      await waitFor(async () => (await groundLoot(pool, worldId)).gold.length > 0);
      await new Promise((r) => setTimeout(r, 100)); // a chest, if wrongly spawned, lands after gold

      const { items, gold } = await groundLoot(pool, worldId);
      assert.equal(items.length, 2 + own, `2 dungeon_elite rolls + ${own} own drop(s)`);
      for (const r of items) assert.ok(atLeast(r.rarity, 'blue'), `${r.name} rolled ${r.rarity}, below the elite floor`);
      assert.ok(gold[0].quantity >= 8 && gold[0].quantity <= 15, `gold ${gold[0].quantity} outside Ossuary Warden's 8..15`);

      const chests = await pool.query('SELECT 1 FROM world_chests WHERE world_id = $1', [worldId]);
      assert.equal(chests.rows.length, 0, 'dungeon_elite defaults to no chest');

      srv.evictWorld(worldId);
    }, { prefix: 'zzS10dungeonElite' });
  } finally {
    srv.close();
    await pool.end();
  }
});

// World boss: "3 per damaging participant" + the pre-existing top-3/gold/
// Victor's Boon (kept). FOUR participants, so "every contributor" (4x3) is
// distinguishable from "top-3 only" (3x3); the boss's own drop rows are
// rolled once per KILL, not once per participant.
test('a world boss kill with 4 participants: 3 rolls each, own drops once, 3 legendaries, a transient chest', { skip }, async () => {
  const pool = new Pool({ connectionString: url, max: 4 });
  const srv = makeServer(pool);
  try {
    const own = await ownDropCount(pool, 'Abyssor, the Voidreaver');
    assert.ok(own >= 1, 'fixture premise: Abyssor has its own drop row, so a per-participant re-roll would show');
    await withFixtureWorld(pool, async (worldId) => {
      const entry = await srv._loadWorld(worldId);
      const worlds = new Map([[worldId, entry]]);
      const wbm = srv._worldBossManager;
      const spawned = wbm.forceSpawn(Date.now(), worlds, { bossName: 'Abyssor, the Voidreaver' }, () => {});
      assert.equal(spawned, true, 'the real catalog has Abyssor, the Voidreaver (SOMET-603 seed)');
      const c = entry.world.creatures.get(wbm.bossCreatureId);
      assert.ok(c, 'the boss is live in the sim');
      c._playerDamage = new Map([['u1', 9000], ['u2', 1000], ['u3', 500], ['u4', 100]]);
      wbm.currentBoss._playerDamage = c._playerDamage;

      const before = (await groundLoot(pool, worldId)).items.length;
      entry.world.creatures._removeKilled(c);
      await srv._onCreatureDeath(entry, wbm.bossCreatureId, 'u1');
      await waitFor(async () => (await pool.query('SELECT 1 FROM world_chests WHERE world_id = $1', [worldId])).rowCount > 0);

      const { items } = await groundLoot(pool, worldId);
      const expected = 4 * 3 + own + 3;
      assert.equal(items.length - before, expected,
        `4 participants x 3 rolls + ${own} own drop(s) once + 3 top-3 legendaries = ${expected}`);
      for (const r of items) {
        assert.equal(r.item_level, 100, 'item level is WORLD_BOSS_LEVEL');
        assert.ok(atLeast(r.rarity, 'yellow'), `${r.name} rolled ${r.rarity}, below the world floor`);
      }

      const chests = await pool.query(
        'SELECT guard_entity_type_id, state, expires_at FROM world_chests WHERE world_id = $1', [worldId],
      );
      assert.equal(chests.rows.length, 1, 'world tier defaults to a chest');
      assert.equal(chests.rows[0].state, 'unlocked');
      assert.ok(chests.rows[0].expires_at, 'the victory chest is transient (DB deadline, not an in-memory timer)');
      const bossType = await pool.query("SELECT id FROM entity_types WHERE name = 'Abyssor, the Voidreaver'");
      assert.equal(chests.rows[0].guard_entity_type_id, bossType.rows[0].id);

      srv.evictWorld(worldId);
    }, { prefix: 'zzS10worldBoss' });
  } finally {
    srv.close();
    await pool.end();
  }
});

test('a per-boss loot_chest override beats the tier default', { skip }, async () => {
  const pool = new Pool({ connectionString: url, max: 4 });
  const srv = makeServer(pool);
  try {
    await pool.query("UPDATE entity_types SET loot_chest = true WHERE name = 'Ossuary Warden'");
    await withFixtureWorld(pool, async (worldId) => {
      const entry = await placeDungeonBoss(pool, srv, worldId, 'Ossuary Warden');
      await killDungeonBoss(srv, entry, worldId);
      await waitFor(async () => (await pool.query('SELECT 1 FROM world_chests WHERE world_id = $1', [worldId])).rowCount > 0);

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
