const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { seedCatalogs, seedOneTile, seedOneBiome } = require('../scripts/seed-catalogs.js');
const { DEFAULT_TILE_TYPES } = require('../seeds/data/tileTypes.js');
const { STARTER_BIOMES } = require('../seeds/data/biomes.js');
const { NEW_DECORATIONS, SIZE_FIXES } = require('../seeds/data/decorationTypes.js');
const { HOSTILE_CREATURES, CREATURE_DROPS } = require('../seeds/data/entityTypes.js');

// Every test in this file calls seedCatalogs(pool), which does
// `ON CONFLICT DO UPDATE` over all 15 tile_types and all 5 biomes -- this is
// "the intended way to author catalog entries" per seed-catalogs.js's own
// header, so a bare `npm test` that reached a developer's real dev database
// would silently revert any catalog row an admin had hand-edited in the UI.
// The 'hand-resized decoration' test below is worse: it writes 777x888 and
// then restores from SIZE_FIXES (64x96) rather than from the value it read,
// so a hand-resized Tree is lost outright, and an interrupted run leaves
// Tree stuck at 777x888.
//
// This is the identical hazard already gated in seed_map_db.test.js -- same
// ruling applies here: skip when TEST_DATABASE_URL is absent, and do NOT
// fall back to DATABASE_URL. A bare `npm test` on a machine with a working
// dev DATABASE_URL must never reach it.
const DB_URL = process.env.TEST_DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

async function openPool() {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 2 });
  try { await pool.query('SELECT 1'); return pool; }
  catch (err) { await pool.end().catch(() => {}); return { unreachable: err.message }; }
}

// Gate ABOVE the CI check, not below it -- see seed_map_db.test.js's "every
// shipped spec applies cleanly" test for why: a CI environment that sets
// DATABASE_URL but not TEST_DATABASE_URL must fail loudly here, not skip.
function requireTestDb(t, why) {
  if (!process.env.TEST_DATABASE_URL) {
    const msg = `TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (${why})`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return false;
  }
  return true;
}

test('seeding catalogs twice is a no-op the second time', async (t) => {
  if (!requireTestDb(t, 'seedCatalogs upserts every tile_type row')) return;
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} (${pool.unreachable}) — catalog seeding is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  try {
    await seedCatalogs(pool);
    const after1 = await pool.query('SELECT name, color, walkable, speed FROM tile_types ORDER BY name');
    await seedCatalogs(pool);
    const after2 = await pool.query('SELECT name, color, walkable, speed FROM tile_types ORDER BY name');

    assert.deepEqual(after2.rows, after1.rows, 'second seed changed tile_types');
    assert.ok(after1.rowCount >= DEFAULT_TILE_TYPES.length,
      'fewer tiles than the seed file defines — the upsert did not apply');
  } finally { await pool.end(); }
});

test('seeding does not delete a hand-added tile type', async (t) => {
  if (!requireTestDb(t, 'seedCatalogs upserts every tile_type row')) return;
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} — hand-added-tile survival is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  const CANARY = 'zz_seed_canary_tile';
  try {
    await pool.query(
      `INSERT INTO tile_types (name, color, walkable, speed, image, valid_neighbors)
       VALUES ($1, '#123456', true, 1.0, '', '[]') ON CONFLICT (name) DO NOTHING`, [CANARY]);
    await seedCatalogs(pool);
    const r = await pool.query('SELECT 1 FROM tile_types WHERE name = $1', [CANARY]);
    assert.equal(r.rowCount, 1, 'seeding deleted a tile type it did not create');
  } finally {
    await pool.query('DELETE FROM tile_types WHERE name = $1', [CANARY]).catch(() => {});
    await pool.end();
  }
});

// The seeder's stated rule is that a run must never cost an admin something
// they authored by hand. Every existing terrain tile carries a prompt in the
// database that is NOT in DEFAULT_TILE_TYPES (verified live: `grass` reads
// "lush green meadow grass"). A naive `prompt = EXCLUDED.prompt` would wipe
// all eleven on the next run.
test('seeding preserves a prompt the seed file does not specify', async (t) => {
  if (!requireTestDb(t, 'seedOneTile upserts a real tile_types row')) return;
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} — prompt preservation is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  try {
    await pool.query(
      `INSERT INTO tile_types (name, color, walkable, speed, prompt)
       VALUES ('zzPromptKeep', '#123456', true, 1, 'hand authored prompt')
       ON CONFLICT (name) DO UPDATE SET prompt = EXCLUDED.prompt`);
    // Re-run the seeder over a seed entry that omits `prompt` entirely.
    await seedOneTile(pool, { name: 'zzPromptKeep', color: '#123456', walkable: true, speed: 1, valid_neighbors: [] });
    const r = await pool.query(`SELECT prompt FROM tile_types WHERE name = 'zzPromptKeep'`);
    assert.equal(r.rows[0].prompt, 'hand authored prompt');
  } finally {
    await pool.query(`DELETE FROM tile_types WHERE name LIKE 'zz%'`);
    await pool.end();
  }
});

test('seeding writes a prompt the seed file does specify', async (t) => {
  if (!requireTestDb(t, 'seedOneTile upserts a real tile_types row')) return;
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} — prompt write is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  try {
    await seedOneTile(pool, {
      name: 'zzPromptWrite', color: '#123456', walkable: true, speed: 1,
      valid_neighbors: [], prompt: 'seeded prompt', wall_height: 48, place_order: 2,
    });
    const r = await pool.query(
      `SELECT prompt, wall_height, place_order FROM tile_types WHERE name = 'zzPromptWrite'`);
    assert.equal(r.rows[0].prompt, 'seeded prompt');
    assert.equal(r.rows[0].wall_height, 48);
    assert.equal(r.rows[0].place_order, 2);
  } finally {
    await pool.query(`DELETE FROM tile_types WHERE name LIKE 'zz%'`);
    await pool.end();
  }
});

// SIZE_FIXES (Tree/Stone/IceRock display size) is a ONE-TIME correction that
// belongs to migration 1714440042000_decoration_types.js — its own `down`
// reverts those columns back to 0x0, which only makes sense for a migration
// step, not an ongoing invariant. The seeder must NOT replay it, or it would
// silently stomp an admin's hand-resized decoration on every `make
// seed-catalogs` run. This test hand-resizes a real seeded decoration to a
// value nothing in any seed file would ever produce, then asserts a seed run
// leaves it alone.
test('seeding does not revert a hand-resized decoration', async (t) => {
  if (!requireTestDb(t, 'this test itself writes 777x888 into a real entity_types row before restoring it')) return;
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} — hand-resized-decoration survival is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  const NAME = 'Tree';
  const original = SIZE_FIXES[NAME];
  const HAND_SIZE = { w: 777, h: 888 };
  try {
    const before = await pool.query('SELECT 1 FROM entity_types WHERE name = $1', [NAME]);
    assert.equal(before.rowCount, 1, `${NAME} is not seeded — cannot exercise this test`);

    await pool.query(
      'UPDATE entity_types SET display_width = $1, display_height = $2 WHERE name = $3',
      [HAND_SIZE.w, HAND_SIZE.h, NAME],
    );
    await seedCatalogs(pool);
    const r = await pool.query(
      'SELECT display_width, display_height FROM entity_types WHERE name = $1', [NAME],
    );
    assert.equal(r.rows[0].display_width, HAND_SIZE.w, 'seeding reverted a hand-resized decoration width');
    assert.equal(r.rows[0].display_height, HAND_SIZE.h, 'seeding reverted a hand-resized decoration height');
  } finally {
    await pool.query(
      'UPDATE entity_types SET display_width = $1, display_height = $2 WHERE name = $3',
      [original.w, original.h, NAME],
    ).catch(() => {});
    await pool.end();
  }
});

test('seeding biomes twice is a no-op the second time', async (t) => {
  if (!requireTestDb(t, 'seedCatalogs upserts every biome row')) return;
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} — biome seeding is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  try {
    await seedCatalogs(pool);
    const cols = 'name, terrain_tiles, flora_types, creature_types, palette, art_style, exclusions, color';
    const after1 = await pool.query(`SELECT ${cols} FROM biomes ORDER BY name`);
    await seedCatalogs(pool);
    const after2 = await pool.query(`SELECT ${cols} FROM biomes ORDER BY name`);

    assert.deepEqual(after2.rows, after1.rows, 'second seed changed biomes');
    assert.ok(after1.rowCount >= STARTER_BIOMES.length,
      'fewer biomes than the seed file defines — the upsert did not apply');
  } finally { await pool.end(); }
});

test('seeding does not delete a hand-added biome', async (t) => {
  if (!requireTestDb(t, 'seedCatalogs upserts every biome row')) return;
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} — hand-added-biome survival is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  const CANARY = 'zz_seed_canary_biome';
  try {
    await pool.query(
      'INSERT INTO biomes (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [CANARY],
    );
    await seedCatalogs(pool);
    const r = await pool.query('SELECT 1 FROM biomes WHERE name = $1', [CANARY]);
    assert.equal(r.rowCount, 1, 'seeding deleted a biome it did not create');
  } finally {
    await pool.query('DELETE FROM biomes WHERE name = $1', [CANARY]).catch(() => {});
    await pool.end();
  }
});

// The biome mirror of 'seeding preserves a prompt the seed file does not
// specify'. P3's 27 new biomes ship `creature_types: []` as a deliberate
// placeholder for P4, and the Biomes admin UI is a first-class authoring
// surface for that field -- so an unconditional
// `creature_types = EXCLUDED.creature_types` reverted an admin's hand-authored
// fauna to [] on the very next `make seed-catalogs`, silently.
test('seeding preserves fauna an admin authored, when the seed entry ships an empty list', async (t) => {
  if (!requireTestDb(t, 'seedOneBiome upserts a real biomes row')) return;
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} — biome fauna preservation is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  const NAME = 'zzFaunaKeep';
  const seedEntry = {
    name: NAME, terrain_tiles: ['grass'], flora_types: ['Stone'],
    creature_types: [],                       // the P3 placeholder
    palette: ['a', 'b'], art_style: 'x', exclusions: 'y', color: '#123456',
  };
  try {
    // First seed: the row is created with the placeholder, as `make
    // seed-catalogs` does for all 27 today.
    await seedOneBiome(pool, seedEntry);
    const created = await pool.query('SELECT creature_types FROM biomes WHERE name = $1', [NAME]);
    assert.deepEqual(created.rows[0].creature_types, [],
      'setup: a brand-new biome must start from the seed file, placeholder and all');

    // An admin then populates the fauna in the Biomes admin UI.
    await pool.query(
      `UPDATE biomes SET creature_types = '["Slime","Bat"]'::jsonb WHERE name = $1`, [NAME]);

    // ...and someone runs the seeder again.
    await seedOneBiome(pool, seedEntry);

    const r = await pool.query(
      'SELECT creature_types, terrain_tiles, art_style FROM biomes WHERE name = $1', [NAME]);
    assert.deepEqual(r.rows[0].creature_types, ['Slime', 'Bat'],
      'the seeder reverted hand-authored fauna to the placeholder');
    // The preservation must be scoped to creature_types alone -- the other
    // columns are still the seed file's to own, or this "fix" would have
    // turned the whole biome upsert into a no-op.
    assert.deepEqual(r.rows[0].terrain_tiles, ['grass']);
    assert.equal(r.rows[0].art_style, 'x');
  } finally {
    await pool.query('DELETE FROM biomes WHERE name = $1', [NAME]).catch(() => {});
    await pool.end();
  }
});

// The mirror-image bug the CASE could introduce: never writing fauna at all.
// P4 fills these lists from the seed file, so a NON-EMPTY seed entry must
// still win over whatever the row holds.
test('seeding still overwrites fauna when the seed entry does specify a list', async (t) => {
  if (!requireTestDb(t, 'seedOneBiome upserts a real biomes row')) return;
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} — biome fauna write is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  const NAME = 'zzFaunaWrite';
  const base = {
    name: NAME, terrain_tiles: ['grass'], flora_types: ['Stone'],
    palette: ['a', 'b'], art_style: 'x', exclusions: 'y', color: '#123456',
  };
  try {
    await seedOneBiome(pool, { ...base, creature_types: ['Slime'] });
    await pool.query(
      `UPDATE biomes SET creature_types = '["Wolf"]'::jsonb WHERE name = $1`, [NAME]);
    await seedOneBiome(pool, { ...base, creature_types: ['Skeleton', 'Bat'] });
    const r = await pool.query('SELECT creature_types FROM biomes WHERE name = $1', [NAME]);
    assert.deepEqual(r.rows[0].creature_types, ['Skeleton', 'Bat'],
      'a seed entry that specifies fauna must still be authoritative');
  } finally {
    await pool.query('DELETE FROM biomes WHERE name = $1', [NAME]).catch(() => {});
    await pool.end();
  }
});

// Every biome in STARTER_BIOMES now ships a real, non-empty creature_types
// (SOMET-251 follow-up closing the SOMET-247/SOMET-250 gap -- see biomes.js's
// header), so a real `seedCatalogs(pool)` run never sources an empty array
// and can no longer reach the CASE branch this test is about: an EXCLUDED
// source of [] preserving whatever creature_types the row already has. This
// test therefore drives seedOneBiome directly with a synthetic empty-array
// row (everything else copied off the real Ossuary seed entry) to pin that
// the preservation logic in seed-catalogs.js's real SQL is still correct,
// not a restatement of it -- not that a full seedCatalogs()/`make
// seed-catalogs` run exercises this path, which it currently does not.
//
// Consequence: there is no live end-to-end test proving a real `make
// seed-catalogs` run won't clobber admin-authored fauna. That guarantee
// currently holds only because no biome in real seed data ships an empty
// creature_types array today; if a future biome ever does, this gap should
// be revisited. Restores the value it READ, not a hard-coded one, so an
// interrupted run cannot invent a state.
test('seedOneBiome preserves hand-authored fauna when its seed source ships an empty creature_types', async (t) => {
  if (!requireTestDb(t, 'this test writes fauna into a real biomes row before restoring it')) return;
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} — end-to-end fauna preservation is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  const NAME = 'Ossuary';
  let original = null;
  try {
    await seedCatalogs(pool);
    const before = await pool.query('SELECT creature_types FROM biomes WHERE name = $1', [NAME]);
    assert.equal(before.rowCount, 1, `${NAME} is not seeded — cannot exercise this test`);
    original = before.rows[0].creature_types;

    // Real creature names, so an interrupted run leaves a valid catalog rather
    // than a dangling reference.
    await pool.query(
      `UPDATE biomes SET creature_types = '["Skeleton"]'::jsonb WHERE name = $1`, [NAME]);

    // Every biome in STARTER_BIOMES now ships a real, non-empty
    // creature_types (SOMET-251 follow-up closing the SOMET-247/SOMET-250
    // gap -- see biomes.js's header), so seedCatalogs(pool) alone no longer
    // exercises the CASE branch this test is about: an EXCLUDED source of []
    // preserving whatever creature_types the row already has. Drive
    // seedOneBiome directly with a synthetic empty-array row for NAME
    // (everything else copied off the real Ossuary seed entry) so the
    // preservation branch is still exercised against the real SQL in
    // seed-catalogs.js, not a restatement of it, even though no shipped seed
    // entry hits that branch by itself any more.
    const ossuarySeed = STARTER_BIOMES.find((b) => b.name === NAME);
    assert.ok(ossuarySeed, `${NAME} missing from STARTER_BIOMES — cannot exercise this test`);
    await seedOneBiome(pool, { ...ossuarySeed, creature_types: [] });

    const r = await pool.query('SELECT creature_types FROM biomes WHERE name = $1', [NAME]);
    assert.deepEqual(r.rows[0].creature_types, ['Skeleton'],
      'an empty-array seed source reverted hand-authored fauna');
  } finally {
    if (original !== null) {
      await pool.query('UPDATE biomes SET creature_types = $2::jsonb WHERE name = $1',
        [NAME, JSON.stringify(original)]).catch(() => {});
    }
    await pool.end();
  }
});

test('seeding decorations twice is a no-op the second time', async (t) => {
  if (!requireTestDb(t, 'seedCatalogs upserts every decoration entity_types row')) return;
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} — decoration seeding is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  try {
    const names = NEW_DECORATIONS.map((d) => d.name);
    await seedCatalogs(pool);
    const cols = 'name, is_creature, walkable, render_mode, spawn_tiles, chance, display_width, display_height, color';
    const after1 = await pool.query(
      `SELECT ${cols} FROM entity_types WHERE name = ANY($1) ORDER BY name`, [names],
    );
    await seedCatalogs(pool);
    const after2 = await pool.query(
      `SELECT ${cols} FROM entity_types WHERE name = ANY($1) ORDER BY name`, [names],
    );

    assert.deepEqual(after2.rows, after1.rows, 'second seed changed decoration entity_types rows');
    assert.ok(after1.rowCount >= NEW_DECORATIONS.length,
      'fewer decorations than the seed file defines — the insert did not apply');
  } finally { await pool.end(); }
});

test('seeding does not delete a hand-added decoration', async (t) => {
  if (!requireTestDb(t, 'seedCatalogs upserts every decoration entity_types row')) return;
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} — hand-added-decoration survival is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  const CANARY = 'zz_seed_canary_decoration';
  try {
    await pool.query(
      `INSERT INTO entity_types
        (name, color, walkable, is_creature, render_mode, spawn_tiles, chance, display_width, display_height)
       VALUES ($1, '#654321', false, false, 'static', '[]', 0.1, 10, 10)
       ON CONFLICT (name) DO NOTHING`, [CANARY],
    );
    await seedCatalogs(pool);
    const r = await pool.query('SELECT 1 FROM entity_types WHERE name = $1', [CANARY]);
    assert.equal(r.rowCount, 1, 'seeding deleted a decoration it did not create');
  } finally {
    await pool.query('DELETE FROM entity_types WHERE name = $1', [CANARY]).catch(() => {});
    await pool.end();
  }
});

// The drop-rule insert is the one statement in seedCatalogs with no unique
// constraint behind it (creature_drops has only an index on entity_type_id --
// see 1714440018000_create_loot.js), so its idempotency rests entirely on the
// hand-written NOT EXISTS guard. Losing that guard would not fail any other
// test: it would just stack a second identical rule on every run, and the
// only symptom is Wolf quietly dropping daggers at ~1.75x the intended rate
// after three seeds.
test('re-seeding does not stack duplicate creature drop rules', async (t) => {
  if (!requireTestDb(t, 'seedCatalogs inserts into creature_drops')) return;
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} — drop-rule idempotency is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  try {
    await seedCatalogs(pool);
    const count = async () => (await pool.query(
      `SELECT count(*)::int AS n
         FROM creature_drops cd
         JOIN entity_types et ON et.id = cd.entity_type_id
         JOIN item_types it ON it.id = cd.item_type_id
        WHERE et.name = $1 AND it.name = $2`,
      [CREATURE_DROPS[0].creature, CREATURE_DROPS[0].item],
    )).rows[0].n;

    const after1 = await count();
    assert.equal(after1, 1, 'the seeded drop rule should exist exactly once');
    await seedCatalogs(pool);
    await seedCatalogs(pool);
    assert.equal(await count(), 1, 'seeding stacked duplicate drop rules');
  } finally { await pool.end(); }
});

// The actual repair this seed data exists for: a creature a biome references
// has gone missing from entity_types (exactly what happened to Wolf when the
// dev Postgres volume was rebuilt). Deleting and restoring is safe here only
// because this test is gated to TEST_DATABASE_URL.
test('seeding restores a creature that is missing from the catalog', async (t) => {
  if (!requireTestDb(t, 'this test DELETEs a creature row before restoring it')) return;
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} — creature restoration is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  const wolf = HOSTILE_CREATURES.find((c) => c.name === 'Wolf');
  try {
    await seedCatalogs(pool);
    // world_creatures references the type by name, and creature_drops by id
    // with ON DELETE CASCADE, so clear the live spawns first (same ordering
    // elements.js's own `down` uses).
    await pool.query('DELETE FROM world_creatures WHERE type = $1', [wolf.name]);
    await pool.query('DELETE FROM entity_types WHERE name = $1', [wolf.name]);
    assert.equal(
      (await pool.query('SELECT 1 FROM entity_types WHERE name = $1', [wolf.name])).rowCount,
      0, 'setup failed: the creature was not actually removed',
    );

    await seedCatalogs(pool);

    const r = await pool.query(
      'SELECT hp, max_hp, is_creature, gold_min, gold_max FROM entity_types WHERE name = $1',
      [wolf.name],
    );
    assert.equal(r.rowCount, 1, 'seeding did not restore the missing creature');
    assert.equal(r.rows[0].hp, wolf.hp);
    assert.equal(r.rows[0].max_hp, wolf.max_hp);
    assert.equal(r.rows[0].is_creature, true, 'restored row must be a creature or it never spawns');
    // The drop rule cascaded away with the row; the seeder must put it back
    // or the restored creature dies yielding nothing and
    // creature_drops_db.test.js's every-creature-has-a-drop invariant breaks.
    const drops = await pool.query(
      `SELECT count(*)::int AS n FROM creature_drops cd
         JOIN entity_types et ON et.id = cd.entity_type_id
        WHERE et.name = $1`, [wolf.name],
    );
    assert.ok(drops.rows[0].n >= 1, 'restored creature has no drop rule');
  } finally { await pool.end(); }
});
