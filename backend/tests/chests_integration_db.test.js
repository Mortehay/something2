const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { applyMapSpec } = require('../scripts/seed-map.js');
const { World } = require('../src/authority/world.js');
const { commitCreatureDeath } = require('../src/authority/loot.js');
const { openChest } = require('../src/authority/chestLoot.js');

// Task 7: end-to-end integration coverage for the whole vault-chest flow,
// against a REAL Postgres database, exercising the real code from every
// earlier task in this feature (Task 3's seed-map authoring, Task 5's
// openChest, the guard-alive check, loot rolling and XP award) in one
// sequence rather than each in isolation. Follows seed_map_vault_chests_db
// .test.js's pool/cleanup/withEntryPreserved pattern exactly (same DB_URL
// fallback, same graceful-skip-if-unreachable shape, same zz-prefix
// convention for owned rows).
const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

// A guard/chest level chosen far outside any realistic in-game band (player
// MAX_LEVEL is 50 -- see progressionConstants.js -- and every world-authored
// level band seen in this codebase's fixtures/specs is well under 100), used
// BOTH as the vault chest's guard level AND as the level_min/level_max band
// of a chest_loot row this test inserts and deletes itself. chest_loot is a
// genuinely shared, level-banded catalog table (unlike the zz-prefixed rows
// this test otherwise owns) -- picking a level no real chest will ever carry
// means this test's temporary row can never be rolled by real gameplay
// during the brief window it exists, and the `finally` below removes it
// unconditionally either way.
const TEST_LEVEL = 500;

async function openPool() {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 4 });
  try { await pool.query('SELECT 1'); return pool; }
  catch (err) { await pool.end().catch(() => {}); return { unreachable: err.message }; }
}

async function withEntryPreserved(pool, fn) {
  const before = await pool.query('SELECT id FROM worlds WHERE is_entry = true');
  const beforeId = before.rows[0]?.id ?? null;
  try {
    return await fn();
  } finally {
    await pool.query(
      'UPDATE worlds SET is_entry = COALESCE(id = $1, false) WHERE is_entry = true OR id = $1',
      [beforeId],
    );
  }
}

async function cleanup(pool, usernamePrefix) {
  await pool.query("DELETE FROM worlds WHERE name = 'zz Chest Integration World'").catch(() => {});
  await pool.query('DELETE FROM chest_loot WHERE level_min = $1 AND level_max = $1', [TEST_LEVEL]).catch(() => {});
  await pool.query('DELETE FROM users WHERE username LIKE $1', [`${usernamePrefix}%`]).catch(() => {});
}

async function createTestUser(pool) {
  const username = `zz-chest-integration-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const r = await pool.query(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'player') RETURNING id`,
    [username],
  );
  return { userId: r.rows[0].id, username };
}

// Wolf is the same pre-existing, read-only baseline creature type Task 3's
// own DB test already references (never mutated, only looked up by name).
// loot_map is the permanent catalog row Task 1's migration seeded via
// `ON CONFLICT DO NOTHING` -- also read-only here, reused as the item this
// test's temporary chest_loot row grants so no new item_types row is needed.
function spec() {
  return {
    name: 'zz-chest-integration-test',
    topology: 'spine',
    worlds: [{
      key: 'a', name: 'zz Chest Integration World', grid: [40, 40], seed: 502,
      width: 10, height: 10, chunk_size: 64, biomes: [], biome_cell: 32,
      allowed_creature_types: [], is_entry: true,
      chest: { x: 500, y: 500, guard_creature_type: 'Wolf', level: TEST_LEVEL },
    }],
    links: [],
  };
}

test('full vault-chest flow: seed -> guard blocks open -> kill guard -> open grants items+XP -> second open rejected', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} (${pool.unreachable}) — chest integration flow is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  // Precondition, checked BEFORE any seeding/mutation: this branch's own
  // migrations (1714440017000_items_inventory.js) define player_items with
  // a `user_id` column, and openChest's item grant
  // (`INSERT INTO player_items (user_id, item_type_id, quantity)`) is
  // written against that shape. The SHARED dev DB this test runs against
  // also carries a concurrent, unmerged branch's migrations
  // (1714440091000_playable_classes / 1714440092000_characters), which have
  // been observed (via `information_schema.columns`) to replace
  // player_items.user_id with character_id on THIS shared instance. That is
  // a cross-branch DB-state drift, not a defect in this feature's code or a
  // regression this task introduced -- and this task's own DB-safety rules
  // forbid touching migrations or altering shared schema to work around it.
  // Skip cleanly (same idiom as the "NO DATABASE" skip above) rather than
  // reporting a false regression when that drift is present; see the task-7
  // report for the full finding.
  const hasUserId = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'player_items' AND column_name = 'user_id'`,
  );
  if (hasUserId.rowCount === 0) {
    const msg = 'player_items.user_id does not exist on this shared DB (superseded by character_id from a '
      + 'concurrent, unmerged player-characters/classes branch\'s migrations) -- openChest\'s item grant is '
      + 'UNVERIFIED against this DB state; this is the same cross-branch schema drift already responsible for '
      + 'this suite\'s known pre-existing consumeAmmo/grantStartingLoadout failures, not a chest-feature defect';
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    await pool.end();
    return;
  }

  const usernamePrefix = 'zz-chest-integration-test-';
  try {
    await cleanup(pool, usernamePrefix);

    // A real item_type row, looked up read-only (never mutated) -- see
    // header comment.
    const itemRow = await pool.query("SELECT id FROM item_types WHERE name = 'loot_map'");
    assert.equal(itemRow.rowCount, 1, 'loot_map must already exist as a permanent catalog row (migration 1714440152000)');
    const itemTypeId = itemRow.rows[0].id;

    // A temporary, narrowly-scoped chest_loot row: chance 1 and min_qty ===
    // max_qty === 2 makes the roll fully deterministic (rollDrops' qty
    // formula degenerates to exactly `min` whenever min===max, regardless of
    // rng), so this test can assert an EXACT items array instead of merely
    // "something non-empty".
    await pool.query(
      `INSERT INTO chest_loot (level_min, level_max, item_type_id, chance, min_qty, max_qty)
       VALUES ($1, $1, $2, 1, 2, 2)`,
      [TEST_LEVEL, itemTypeId],
    );

    const { userId } = await createTestUser(pool);

    let worldId; let chestId; let guardCreatureId;
    await withEntryPreserved(pool, async () => {
      const result = await applyMapSpec(pool, spec());
      assert.equal(result.vaultChests, 1, 'the spec must author exactly one vault chest');

      const world = await pool.query("SELECT id FROM worlds WHERE name = 'zz Chest Integration World'");
      worldId = world.rows[0].id;

      const chest = await pool.query('SELECT id, guard_creature_ids, state FROM world_chests WHERE world_id = $1', [worldId]);
      assert.equal(chest.rowCount, 1);
      chestId = chest.rows[0].id;
      assert.equal(chest.rows[0].state, 'locked', 'a freshly-authored vault chest must start locked');
      guardCreatureId = chest.rows[0].guard_creature_ids[0];
      assert.ok(guardCreatureId, 'the chest must reference its guard creature');

      const guard = await pool.query("SELECT id FROM world_creatures WHERE world_id = $1 AND type = 'Wolf'", [worldId]);
      assert.equal(guard.rowCount, 1, 'exactly one guard must be spawned');
      assert.equal(guard.rows[0].id, guardCreatureId, 'the guard row must be the same one the chest references');

      // --- Step: opening while the guard is alive must be refused, and the
      // chest must stay locked (real DB guard-alive check, not mocked). ---
      const blocked = await openChest(pool, chestId, userId);
      assert.equal(blocked.ok, false);
      assert.equal(blocked.reason, 'guard is still alive');
      const stillLocked = await pool.query('SELECT state FROM world_chests WHERE id = $1', [chestId]);
      assert.equal(stillLocked.rows[0].state, 'locked', 'a refused open must not transition the chest at all');

      // --- Step: kill the guard through the real commit path
      // (commitCreatureDeath), the same function every real creature kill in
      // this codebase goes through -- not a raw DELETE. killerUserId is
      // null: a chest's guard is not "killed by" the player who later opens
      // the chest in this flow (mirrors how village/portal guards work),
      // and openChest awards its OWN xpForChest amount on open regardless.
      const map = {
        chunkSize: 64, isWalkable: () => true, speedAt: () => 1, getChunk: () => [],
      };
      const entry = { worldId, world: new World(map, new Map(), null, 64), creatureTypeIds: new Map() };
      const death = await commitCreatureDeath(pool, entry, guardCreatureId, { killerUserId: null });
      assert.ok(death, 'the guard must actually die (rowCount gate must not refuse this real DELETE)');

      const guardGone = await pool.query('SELECT count(*)::int AS n FROM world_creatures WHERE id = $1', [guardCreatureId]);
      assert.equal(guardGone.rows[0].n, 0, 'the guard row must be gone after commitCreatureDeath');

      // --- Step: open the now-unguarded chest -- items granted, XP awarded. ---
      const opened = await openChest(pool, chestId, userId);
      assert.equal(opened.ok, true, `open must now succeed: ${opened.reason}`);
      assert.deepEqual(opened.items, [itemTypeId, itemTypeId], 'exactly 2 units of the seeded loot_map drop, deterministic under chance=1/min=max=2');
      assert.ok(opened.awarded > 0, 'a level-500 guard opened by a level-1 player must award positive XP');
      assert.equal(opened.respawnAt, null, 'a vault chest never gets a respawn timer');
      assert.ok(opened.openedAt, 'openedAt must be set on a successful open');

      const grantedItems = await pool.query(
        'SELECT item_type_id FROM player_items WHERE user_id = $1 ORDER BY id', [userId],
      );
      assert.equal(grantedItems.rowCount, 2, 'exactly 2 player_items rows must be persisted');
      assert.ok(grantedItems.rows.every((r) => r.item_type_id === itemTypeId));

      const progression = await pool.query('SELECT experience FROM player_progression WHERE user_id = $1', [userId]);
      assert.equal(progression.rowCount, 1, 'opening a chest must lazily create/update a player_progression row');
      assert.equal(Number(progression.rows[0].experience), opened.awarded, 'the persisted XP must match the amount openChest reported');

      const chestState = await pool.query('SELECT state FROM world_chests WHERE id = $1', [chestId]);
      assert.equal(chestState.rows[0].state, 'opened');

      // --- Step: a second open of the same, now-opened chest must be
      // rejected -- and must not grant a second round of items/XP. ---
      const second = await openChest(pool, chestId, userId);
      assert.equal(second.ok, false);
      assert.equal(second.reason, 'already opened');

      const itemsAfterSecond = await pool.query('SELECT count(*)::int AS n FROM player_items WHERE user_id = $1', [userId]);
      assert.equal(itemsAfterSecond.rows[0].n, 2, 'a rejected second open must not grant any additional items');
      const xpAfterSecond = await pool.query('SELECT experience FROM player_progression WHERE user_id = $1', [userId]);
      assert.equal(Number(xpAfterSecond.rows[0].experience), opened.awarded, 'a rejected second open must not award any additional XP');
    });
  } finally {
    await cleanup(pool, usernamePrefix);
    await pool.end();
  }
});
