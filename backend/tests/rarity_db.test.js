// SOMET-481 (progression epic T13). The WIRING test.
//
// The pure roller in rarity.test.js proves nothing about whether a rolled
// grade ever reaches the database. Four separate items in this epic shipped a
// feature that was completely inert while every unit test stayed green, so
// everything here goes through the REAL path: a real creature row is killed
// through commitCreatureDeath, and the resulting world_items row is read back
// out of Postgres and then picked up through claimItem.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { World } = require('../src/authority/world.js');
const { loadItemTypes, loadInventory } = require('../src/authority/items.js');
const { commitCreatureDeath, claimItem } = require('../src/authority/loot.js');
const { openChest } = require('../src/authority/chestLoot.js');
const { interpolateWeights } = require('../src/authority/rarity.js');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

async function openPool() {
  if (!DB_URL) return { unreachable: 'no TEST_DATABASE_URL / DATABASE_URL' };
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 4 });
  try { await pool.query('SELECT 1'); } catch (err) {
    await pool.end().catch(() => {});
    return { unreachable: `NO DATABASE at ${DB_URL} (${err.message})` };
  }
  return pool;
}

function uniq(tag) {
  return `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Every fixture row is created by THIS test and torn down by THIS test.
// Nothing here touches a pre-existing user, character or world.
async function fixture(pool, tag) {
  const u = await pool.query(
    `INSERT INTO users (username, password_hash, role)
     VALUES ($1, 'x', 'player') RETURNING id`,
    [uniq(`rar-${tag}`)],
  );
  const userId = u.rows[0].id;
  const c = await pool.query(
    `INSERT INTO characters (user_id, slot, name, entity_type_id)
     SELECT $1, 1, $2, e.id FROM entity_types e WHERE e.is_playable = true
      ORDER BY e.id LIMIT 1 RETURNING id`,
    [userId, uniq(`rar-char-${tag}`)],
  );
  const w = await pool.query(
    `INSERT INTO worlds (name, width, height, chunk_size, seed)
     VALUES ($1, 64, 64, 16, 1) RETURNING id`,
    [uniq(`rar-world-${tag}`)],
  );
  return { userId, characterId: c.rows[0].id, worldId: w.rows[0].id };
}

async function cleanup(pool, fx) {
  if (!fx) return;
  await pool.query('DELETE FROM world_chests WHERE world_id = $1', [fx.worldId]).catch(() => {});
  await pool.query('DELETE FROM creature_respawns WHERE world_id = $1', [fx.worldId]).catch(() => {});
  await pool.query('DELETE FROM world_creatures WHERE world_id = $1', [fx.worldId]).catch(() => {});
  await pool.query('DELETE FROM world_items WHERE world_id = $1', [fx.worldId]).catch(() => {});
  await pool.query(
    'DELETE FROM player_item_affixes WHERE player_item_id IN (SELECT id FROM player_items WHERE character_id = $1)',
    [fx.characterId],
  ).catch(() => {});
  await pool.query('DELETE FROM player_items WHERE character_id = $1', [fx.characterId]).catch(() => {});
  await pool.query('DELETE FROM player_progression WHERE character_id = $1', [fx.characterId]).catch(() => {});
  await pool.query('DELETE FROM characters WHERE id = $1', [fx.characterId]).catch(() => {});
  await pool.query('DELETE FROM worlds WHERE id = $1', [fx.worldId]).catch(() => {});
  await pool.query('DELETE FROM users WHERE id = $1', [fx.userId]).catch(() => {});
}

// Everything in this file kills a creature of a type THIS test authors, with a
// drop table THIS test authors, so it never depends on what the seeded
// bestiary happens to drop.
async function authorCreature(pool, tag, itemTypeId) {
  const e = await pool.query(
    `INSERT INTO entity_types (name, color, is_creature, is_playable)
     VALUES ($1, '#888', true, false) RETURNING id, name`,
    [uniq(`rar-mob-${tag}`)],
  );
  await pool.query(
    `INSERT INTO creature_drops (entity_type_id, item_type_id, chance, min_qty, max_qty)
     VALUES ($1, $2, 1, 1, 1)`,
    [e.rows[0].id, itemTypeId],
  );
  return e.rows[0];
}

async function dropAuthoredCreature(pool, entityTypeId) {
  await pool.query('DELETE FROM creature_drops WHERE entity_type_id = $1', [entityTypeId]).catch(() => {});
  await pool.query('DELETE FROM entity_types WHERE id = $1', [entityTypeId]).catch(() => {});
}

async function armEntry(pool, fx, extra = {}) {
  const itemTypes = await loadItemTypes(pool);
  const map = {
    chunkSize: 16, isWalkable: () => true, speedAt: () => 1, getChunk: () => [],
  };
  const world = new World(map, itemTypes, null, 16);
  const inv = await loadInventory(pool, fx.characterId);
  world.addPlayer(String(fx.userId), { x: 100, y: 100 }, inv, { x: 100, y: 100 }, 0, undefined, fx.characterId);
  return {
    entry: {
      worldId: fx.worldId,
      world,
      claiming: new Set(),
      creatureTypeIds: new Map(),
      ...extra,
    },
    itemTypes,
  };
}

// Every column server.js's refreshLootTuning reads, so this test would notice
// a column that stopped being selected there.
async function loadAffixPool(pool, key) {
  const r = await pool.query(
    `SELECT id, key, kind, effect, min_value, max_value, min_item_level, max_item_level,
            allowed_slots, min_rarity, weight
       FROM affix_types WHERE key = $1`,
    [key],
  );
  return r.rows;
}

test('game_settings carries a usable rarity_weights row', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  t.after(async () => { await pool.end().catch(() => {}); });

  const r = await pool.query("SELECT value FROM game_settings WHERE key = 'rarity_weights'");
  assert.strictEqual(r.rowCount, 1, 'the rarity_weights row must exist');
  const anchors = r.rows[0].value;
  assert.ok(Array.isArray(anchors));
  // Hand-written expectation of the seeded table.
  assert.deepStrictEqual(anchors, [
    { item_level: 1, white: 90, blue: 9, yellow: 1, foxy: 0 },
    { item_level: 50, white: 70, blue: 21, yellow: 8, foxy: 1 },
    { item_level: 150, white: 45, blue: 30, yellow: 20, foxy: 5 },
  ]);
  // And it must survive the roller, not just look right.
  assert.deepStrictEqual(interpolateWeights(1, anchors),
    { white: 0.9, blue: 0.09, yellow: 0.01, foxy: 0 });
  assert.deepStrictEqual(interpolateWeights(150, anchors),
    { white: 0.45, blue: 0.3, yellow: 0.2, foxy: 0.05 });
});

test('killing a creature writes a ROLLED rarity onto the real world_items row', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }

  let fx = null;
  let mob = null;
  // ONE after-hook, and the pool is ended INSIDE it, last. node:test runs
  // after-hooks in registration order, so a separate `t.after(pool.end)`
  // registered earlier closes the pool before cleanup runs -- and because
  // every cleanup statement swallows its error, the leak is completely silent.
  // It cost this file two peer-test failures (a leaked entity_types row with
  // no behaviour, a leaked chest_loot band) before it was noticed.
  t.after(async () => {
    await cleanup(pool, fx);
    if (mob) await dropAuthoredCreature(pool, mob.id);
    await pool.end().catch(() => {});
  });

  fx = await fixture(pool, 'kill');
  const typeRow = await pool.query('SELECT id FROM item_types ORDER BY id LIMIT 1');
  const itemTypeId = typeRow.rows[0].id;
  mob = await authorCreature(pool, 'kill', itemTypeId);

  const affixPool = await loadAffixPool(pool, 'of_might');
  assert.strictEqual(affixPool.length, 1, 'the of_might affix must be seeded');

  const { entry } = await armEntry(pool, fx, {
    creatureTypeIds: new Map([[mob.name, mob.id]]),
    // Foxy-only, so the assertion below cannot pass by accident on a white
    // default: 'white' is what a completely unwired rarity path produces.
    rarityAnchors: [{ item_level: 1, white: 0, blue: 0, yellow: 0, foxy: 1 }],
    affixPool,
  });

  const cr = await pool.query(
    `INSERT INTO world_creatures (world_id, type, x, y, hp, level, home_x, home_y)
     VALUES ($1, $2, 40, 40, 1, 100, NULL, NULL) RETURNING id`,
    [fx.worldId, mob.name],
  );

  const res = await commitCreatureDeath(pool, entry, cr.rows[0].id, { rng: () => 0, ttlMs: 60000 });
  assert.ok(res, 'the death must commit');

  const ground = await pool.query(
    'SELECT id, rarity, item_level, affixes FROM world_items WHERE world_id = $1', [fx.worldId],
  );
  assert.strictEqual(ground.rows.length, 1, 'exactly one drop reached the ground');
  assert.strictEqual(ground.rows[0].rarity, 'foxy');
  assert.strictEqual(ground.rows[0].item_level, 100, 'the killed creature level is the item level');
  assert.strictEqual(ground.rows[0].affixes.length, 1);
  // Hand-computed: of_might rolls 1..12, rng 0 takes the minimum 1; the level
  // scale is 1 + (100 - 1)/100 = 1.99; foxy multiplies by 1.25.
  // 1 * 1.99 * 1.25 = 2.4875, rounded to two decimals = 2.49.
  assert.deepStrictEqual(ground.rows[0].affixes[0],
    { affixTypeId: affixPool[0].id, value: 2.49 });

  // And the rolled identity survives the pickup, into the in-memory inventory
  // AND into player_items -- a grade that only exists on the ground is a
  // feature that vanishes the moment a player uses it.
  const claimed = await claimItem(pool, entry, String(fx.userId), fx.characterId, ground.rows[0].id);
  assert.ok(claimed, 'the claim must succeed');
  const held = await pool.query(
    'SELECT rarity, item_level FROM player_items WHERE id = $1', [claimed.id],
  );
  assert.strictEqual(held.rows[0].rarity, 'foxy');
  assert.strictEqual(held.rows[0].item_level, 100);
  const heldAffixes = await pool.query(
    'SELECT affix_type_id, value FROM player_item_affixes WHERE player_item_id = $1', [claimed.id],
  );
  assert.strictEqual(heldAffixes.rowCount, 1);
  assert.strictEqual(Number(heldAffixes.rows[0].value), 2.49);

  const inMemory = entry.world.getPlayer(String(fx.userId)).inv.items.find((i) => i.id === claimed.id);
  assert.ok(inMemory, 'the claimed item must be in the live inventory');
  assert.strictEqual(inMemory.rarity, 'foxy');
  assert.strictEqual(inMemory.affixes.length, 1);
  assert.strictEqual(inMemory.affixes[0].effect.type, 'stat',
    'the live copy carries the effect payload gearStatGrants reads');
});

test('a level-1 kill never produces a foxy drop against the SEEDED table', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }

  let fx = null;
  let mob = null;
  t.after(async () => {
    await cleanup(pool, fx);
    if (mob) await dropAuthoredCreature(pool, mob.id);
    await pool.end().catch(() => {});
  });

  fx = await fixture(pool, 'lvl1');
  const typeRow = await pool.query('SELECT id FROM item_types ORDER BY id LIMIT 1');
  mob = await authorCreature(pool, 'lvl1', typeRow.rows[0].id);

  // The real seeded table, read from the database rather than hand-built:
  // this is the one assertion that has to be about what the game actually
  // ships, not about a fixture.
  const s = await pool.query("SELECT value FROM game_settings WHERE key = 'rarity_weights'");
  const { entry } = await armEntry(pool, fx, {
    creatureTypeIds: new Map([[mob.name, mob.id]]),
    rarityAnchors: s.rows[0].value,
    affixPool: await loadAffixPool(pool, 'of_might'),
  });

  // 40 kills with a swept rng, so the roll walks the whole cumulative range
  // including its very top -- the only place a zero-weight foxy could leak in.
  const seen = new Set();
  for (let i = 0; i < 40; i += 1) {
    /* eslint-disable no-await-in-loop */
    const cr = await pool.query(
      `INSERT INTO world_creatures (world_id, type, x, y, hp, level, home_x, home_y)
       VALUES ($1, $2, 40, 40, 1, 1, NULL, NULL) RETURNING id`,
      [fx.worldId, mob.name],
    );
    const r = i / 40;
    await commitCreatureDeath(pool, entry, cr.rows[0].id, { rng: () => r, ttlMs: 60000 });
    /* eslint-enable no-await-in-loop */
  }
  const ground = await pool.query(
    'SELECT rarity, item_level FROM world_items WHERE world_id = $1', [fx.worldId],
  );
  assert.ok(ground.rows.length > 0, 'the authored drop table must have produced drops');
  for (const row of ground.rows) {
    seen.add(row.rarity);
    assert.strictEqual(row.item_level, 1);
  }
  assert.ok(!seen.has('foxy'), `a level-1 kill produced ${[...seen].join(', ')}`);
  assert.ok(seen.has('white'), 'a level-1 kill must still produce white items');
});

test('opening a chest grants a ROLLED rarity, its affix rows and the live effect payload', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }

  let fx = null;
  let bandId = null;
  t.after(async () => {
    await cleanup(pool, fx);
    if (bandId) await pool.query('DELETE FROM chest_loot WHERE id = $1', [bandId]).catch(() => {});
    await pool.end().catch(() => {});
  });
  fx = await fixture(pool, 'chest');

  // A chest_loot band this test owns, so the grant does not depend on the
  // seeded loot table. level_min/level_max are keyed off the guard level below.
  const typeRow = await pool.query('SELECT id FROM item_types ORDER BY id LIMIT 1');
  const itemTypeId = typeRow.rows[0].id;
  const band = await pool.query(
    `INSERT INTO chest_loot (item_type_id, chance, min_qty, max_qty, level_min, level_max)
     VALUES ($1, 1, 1, 1, 77, 77) RETURNING id`,
    [itemTypeId],
  );
  bandId = band.rows[0].id;

  // guard_entity_type_id is NOT NULL; the chest is already 'unlocked' with no
  // live guards, so which type it names does not affect the open.
  const guard = await pool.query(
    'SELECT id FROM entity_types WHERE is_creature = true ORDER BY id LIMIT 1',
  );
  const ch = await pool.query(
    `INSERT INTO world_chests (world_id, x, y, kind, state, guard_creature_ids, guard_level, guard_entity_type_id)
     VALUES ($1, 10, 10, 'field', 'unlocked', '[]'::jsonb, 77, $2) RETURNING id`,
    [fx.worldId, guard.rows[0].id],
  );

  const affixPool = await loadAffixPool(pool, 'of_might');
  const itemTypes = await loadItemTypes(pool);
  const result = await openChest(pool, ch.rows[0].id, fx.characterId, {
    rng: () => 0,
    rarityAnchors: [{ item_level: 1, white: 0, blue: 0, yellow: 0, foxy: 1 }],
    affixPool,
    itemTypes,
  });
  assert.ok(result.ok, `openChest refused: ${result.reason}`);
  // The seeded chest_loot catalog also covers level 77, so the grant is the
  // union of those bands and the one this test authored -- assert on the
  // PROPERTY every granted item must have, not on a count this test does not
  // own.
  assert.ok(result.items.length >= 1, 'the chest granted nothing');
  assert.ok(result.items.some((i) => i.item_type_id === itemTypeId),
    "the test's own chest_loot band did not contribute an item");
  for (const it of result.items) {
    assert.strictEqual(it.rarity, 'foxy');
    assert.strictEqual(it.item_level, 77, 'the guard level is the item level');
    // The in-memory copy the caller pushes onto p.inv.items must carry the
    // effect payload, or the grant is inert until the next reconnect.
    assert.strictEqual(it.affixes.length, 1, 'one eligible affix in the pool, one rolled');
    assert.strictEqual(it.affixes[0].effect.type, 'stat');
  }

  const persisted = await pool.query(
    'SELECT rarity, item_level FROM player_items WHERE character_id = $1', [fx.characterId],
  );
  assert.strictEqual(persisted.rows.length, result.items.length);
  for (const row of persisted.rows) {
    assert.strictEqual(row.rarity, 'foxy');
    assert.strictEqual(row.item_level, 77);
  }
  const rows = await pool.query(
    `SELECT pa.value FROM player_item_affixes pa
       JOIN player_items pi ON pi.id = pa.player_item_id
      WHERE pi.character_id = $1`,
    [fx.characterId],
  );
  assert.strictEqual(rows.rowCount, result.items.length);
  for (const row of rows.rows) {
    // Hand-computed: of_might rolls 1..12, rng 0 takes the minimum 1; the
    // level scale is 1 + (77 - 1)/100 = 1.76; foxy multiplies by 1.25.
    // 1 * 1.76 * 1.25 = 2.2
    assert.strictEqual(Number(row.value), 2.2);
  }
});

test('a chest opened with no rarity anchors still grants a plain white item', async (t) => {
  // Criterion 5's chest half, and the guard on every existing openChest
  // caller/fixture: the new options default to "no rolling".
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }

  let fx = null;
  let bandId = null;
  t.after(async () => {
    await cleanup(pool, fx);
    if (bandId) await pool.query('DELETE FROM chest_loot WHERE id = $1', [bandId]).catch(() => {});
    await pool.end().catch(() => {});
  });
  fx = await fixture(pool, 'chest-plain');

  const typeRow = await pool.query('SELECT id FROM item_types ORDER BY id LIMIT 1');
  const band = await pool.query(
    `INSERT INTO chest_loot (item_type_id, chance, min_qty, max_qty, level_min, level_max)
     VALUES ($1, 1, 1, 1, 78, 78) RETURNING id`,
    [typeRow.rows[0].id],
  );
  bandId = band.rows[0].id;
  const guard = await pool.query(
    'SELECT id FROM entity_types WHERE is_creature = true ORDER BY id LIMIT 1',
  );
  const ch = await pool.query(
    `INSERT INTO world_chests (world_id, x, y, kind, state, guard_creature_ids, guard_level, guard_entity_type_id)
     VALUES ($1, 10, 10, 'field', 'unlocked', '[]'::jsonb, 78, $2) RETURNING id`,
    [fx.worldId, guard.rows[0].id],
  );

  const result = await openChest(pool, ch.rows[0].id, fx.characterId, { rng: () => 0 });
  assert.ok(result.ok, `openChest refused: ${result.reason}`);
  assert.ok(result.items.length >= 1, 'the chest granted nothing');
  for (const it of result.items) {
    assert.strictEqual(it.rarity, 'white');
    assert.deepStrictEqual(it.affixes, []);
  }
  const affixRows = await pool.query(
    `SELECT count(*)::int AS n FROM player_item_affixes pa
       JOIN player_items pi ON pi.id = pa.player_item_id
      WHERE pi.character_id = $1`,
    [fx.characterId],
  );
  assert.strictEqual(affixRows.rows[0].n, 0, 'a white grant must write no affix rows');
});
