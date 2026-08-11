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

// Was a private copy of withEntryPreserved carrying the pre-SOMET-265 restore
// (`SET is_entry = COALESCE(id = $1, false)`), which clears every row and sets
// none when beforeId is null -- i.e. whenever this file snapshotted while
// another parallel file was mid-apply. This suite is also the one that had
// never actually run until it was un-skipped, so its copy started wiping the
// dev database's entry world the moment it came to life.
//
// Now the shared helper, which guards the whole save/restore window with an
// advisory lock. A private copy does not take that lock and therefore breaks
// the serialisation for every other file too.
const { withEntryPreserved } = require('./helpers/entryWorld.js');

async function cleanup(pool, usernamePrefix) {
  await pool.query("DELETE FROM worlds WHERE name = 'zz Chest Integration World'").catch(() => {});
  await pool.query('DELETE FROM chest_loot WHERE level_min = $1 AND level_max = $1', [TEST_LEVEL]).catch(() => {});
  await pool.query('DELETE FROM users WHERE username LIKE $1', [`${usernamePrefix}%`]).catch(() => {});
}

// Returns a character as well as a user. openChest grants items and XP to a
// CHARACTER (SOMET-257/260), which this fixture predates -- it was written on
// the chests branch against the account-keyed schema, and guarded itself with a
// skip until the two lines merged. They have now merged, so it creates the
// character and the test actually runs.
async function createTestUser(pool) {
  const username = `zz-chest-integration-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const r = await pool.query(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'player') RETURNING id`,
    [username],
  );
  const userId = r.rows[0].id;
  const c = await pool.query(
    `INSERT INTO characters (user_id, slot, name, entity_type_id)
     SELECT $1, 1, $2, e.id FROM entity_types e WHERE e.name = 'Warrior' RETURNING id`,
    [userId, `${username}-char`],
  );
  assert.ok(c.rows.length, 'fixture setup failed: no Warrior class in entity_types');
  return { userId, characterId: c.rows[0].id, username };
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
  // The skip that used to live here waited for a merge that has now happened.
  // It checked for player_items.user_id and bailed when the shared dev DB had
  // character_id instead, calling that "cross-branch DB-state drift". It was
  // right to skip rather than report a false regression -- but with the
  // player-characters line merged in, character_id IS the schema, openChest
  // has been rekeyed to it, and this test has to actually run or the rekeying
  // is unverified against a real database.

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

    const { userId, characterId } = await createTestUser(pool);

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
      const blocked = await openChest(pool, chestId, characterId);
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
      const opened = await openChest(pool, chestId, characterId);
      assert.equal(opened.ok, true, `open must now succeed: ${opened.reason}`);
      // `items` is FULL player_items rows ({id, item_type_id, quantity}), not
      // bare item_type_ids -- SOMET-244's own final-review fix changed that so
      // the openchest handler could push each grant onto p.inv.items. This
      // assertion still expected the old bare-id shape, and nobody noticed
      // because the whole test self-skipped on this database until now.
      assert.equal(opened.items.length, 2,
        'exactly 2 units of the seeded loot_map drop, deterministic under chance=1/min=max=2');
      assert.deepEqual(opened.items.map((i) => i.item_type_id), [itemTypeId, itemTypeId]);
      assert.ok(opened.items.every((i) => i.id && Number(i.quantity) === 1),
        'each granted row must carry the id and quantity the handler needs to update the live inventory');
      assert.ok(opened.awarded > 0, 'a level-500 guard opened by a level-1 player must award positive XP');
      assert.equal(opened.respawnAt, null, 'a vault chest never gets a respawn timer');
      assert.ok(opened.openedAt, 'openedAt must be set on a successful open');

      const grantedItems = await pool.query(
        'SELECT item_type_id FROM player_items WHERE character_id = $1 ORDER BY id', [characterId],
      );
      assert.equal(grantedItems.rowCount, 2, 'exactly 2 player_items rows must be persisted');
      assert.ok(grantedItems.rows.every((r) => r.item_type_id === itemTypeId));

      const progression = await pool.query('SELECT experience FROM player_progression WHERE character_id = $1', [characterId]);
      assert.equal(progression.rowCount, 1, 'opening a chest must lazily create/update a player_progression row');
      assert.equal(Number(progression.rows[0].experience), opened.awarded, 'the persisted XP must match the amount openChest reported');

      const chestState = await pool.query('SELECT state FROM world_chests WHERE id = $1', [chestId]);
      assert.equal(chestState.rows[0].state, 'opened');

      // --- Step: a second open of the same, now-opened chest must be
      // rejected -- and must not grant a second round of items/XP. ---
      const second = await openChest(pool, chestId, characterId);
      assert.equal(second.ok, false);
      assert.equal(second.reason, 'already opened');

      const itemsAfterSecond = await pool.query('SELECT count(*)::int AS n FROM player_items WHERE character_id = $1', [characterId]);
      assert.equal(itemsAfterSecond.rows[0].n, 2, 'a rejected second open must not grant any additional items');
      const xpAfterSecond = await pool.query('SELECT experience FROM player_progression WHERE character_id = $1', [characterId]);
      assert.equal(Number(xpAfterSecond.rows[0].experience), opened.awarded, 'a rejected second open must not award any additional XP');
    });
  } finally {
    await cleanup(pool, usernamePrefix);
    await pool.end();
  }
});
