// backend/tests/blackfen_sinks_navigable_seed.test.js
//
// SOMET-273's residual defect: Blackfen Sinks' LIVE doorways (N, E -- see
// 1714440164000's commit message for why these differ from the spec's stale
// single S doorway) formed a sealed pocket at its then-current seed, 2005.
// This covers the fix migration, 1714440165000_blackfen_sinks_navigable_seed.js
// (the seed swap touches only Blackfen Sinks, and its chosen seed, 2011, was
// navigable with the world's REAL doorways -- not the spec's -- at the 64x64
// size mire had then), AND the world's actual current state: SOMET-306/307
// (this branch, SOMET-301) moved mire onto the size ramp (96x96 now) and
// re-picked its seed again, to 2006 -- independently of this migration, by
// re-applying hub-vale.map.json. 2011 does not survive that resize (see
// below); this file checks what is actually true today, not just what this
// one migration once fixed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const MIGRATION = '1714440165000_blackfen_sinks_navigable_seed.js';
const mig = require(`../migrations/${MIGRATION}`);
const { fetchLinks } = require('../src/services/mapLinks.js');
const { fetchVillages } = require('../src/services/villages.js');
const { requiredTilesFor } = require('../scripts/seed-map.js');
const { buildWorldGenConfig } = require('../src/services/worldGenConfig.js');
const { assertNavigable } = require('../src/services/navigability.js');
const { DEFAULT_TILE_TYPES } = require('../seeds/data/tileTypes.js');
const { STARTER_BIOMES } = require('../seeds/data/biomes.js');

const OLD_SEED = 2005;
const NEW_SEED = 2011;

function emitted(fn) {
  const out = [];
  fn({ sql: (s) => out.push(s), func: (s) => ({ __func: s }) });
  return out.join('\n');
}

test('up sets Blackfen Sinks to the new seed, and only if not already set', () => {
  const sql = emitted(mig.up);
  assert.match(sql, new RegExp(`UPDATE worlds SET seed = ${NEW_SEED}`));
  assert.match(sql, /WHERE name = 'Blackfen Sinks'/);
  // Re-running must be a no-op rather than rewriting the row every deploy.
  assert.match(sql, new RegExp(`AND seed != ${NEW_SEED}`),
    're-running the migration must not touch an already-migrated row');
  // The blast radius is the point: an unscoped UPDATE would reseed every
  // world in the game.
  assert.doesNotMatch(sql, /UPDATE worlds SET seed = \d+\s*(;|$)/m);
  // The persisted terrain cache must be cleared, scoped the same way, or a
  // stale row for the old seed keeps serving the sealed layout.
  assert.match(sql, /DELETE FROM world_chunks USING worlds/);
  assert.match(sql, /worlds\.name = 'Blackfen Sinks'/);
});

test('down restores the original seed and clears the chunk cache the same way', () => {
  const sql = emitted(mig.down);
  assert.match(sql, new RegExp(`UPDATE worlds SET seed = ${OLD_SEED}`));
  assert.match(sql, /WHERE name = 'Blackfen Sinks'/);
  assert.match(sql, new RegExp(`AND seed != ${OLD_SEED}`));
  assert.match(sql, /DELETE FROM world_chunks USING worlds/);
  assert.match(sql, /worlds\.name = 'Blackfen Sinks'/);
  assert.notEqual(emitted(mig.down).trim(), '', 'down must not be a silent no-op');
});

// Offline (no DB): the same harness p5_navigability.test.js uses, fed the
// candidate seed. Proves the FIX independent of whatever state the live
// database happens to be in, and pins the regression it fixes.
const TILE_TYPES = Object.fromEntries(
  DEFAULT_TILE_TYPES.map((t) => [t.name, { walkable: t.walkable }]),
);
const BIOMES_BY_NAME = new Map(STARTER_BIOMES.map((b) => [b.name, b]));
// Blackfen Sinks' real live doorways (map_links), NOT hub-vale.map.json's
// declared topology -- see 1714440164000's commit message for why they
// differ (Blackfen Sinks N -> Sunscar Flats, E -> Rimehollow; the spec only
// ever declared S -> mire/hub).
const LIVE_DOORWAYS = ['N', 'E'];

// mire's real current width/height/seed, read straight from the spec that
// actually seeds it (hub-vale.map.json) instead of a literal copied into
// this file -- SOMET-306/307 moved mire off the old uniform 64x64 onto the
// size ramp (now 96x96) and re-picked its seed (2005 -> 2006, this
// migration's NEW_SEED=2011 is unrelated to that pick, see below). A
// hardcoded 64 here kept this offline leg green while asserting a fact about
// a size the world no longer has (SOMET-301 final review, finding 1).
const HUB_VALE_SPEC = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../seeds/maps/hub-vale.map.json'), 'utf8'));
const MIRE_SPEC = HUB_VALE_SPEC.worlds.find((w) => w.key === 'mire');
assert.ok(MIRE_SPEC, "hub-vale.map.json has no 'mire' world -- update this test's assumptions");

function checkSeed(seed, width, height) {
  const w = {
    key: 'mire', name: 'Blackfen Sinks',
    width, height, chunk_size: 32, biome_cell: 16,
    entry_spawn: null, biomes: ['Storm Coast', 'Mire'],
  };
  const row = {
    seed, chunk_size: w.chunk_size, width: w.width, height: w.height,
    entry_spawn: w.entry_spawn, biome_cell: w.biome_cell,
    level_min: 1, level_max: 1,
  };
  const biomes = w.biomes.map((n) => BIOMES_BY_NAME.get(n)).filter(Boolean);
  assert.equal(biomes.length, w.biomes.length, 'Blackfen Sinks references a biome not in STARTER_BIOMES');
  const cfg = buildWorldGenConfig({ row, tileTypes: TILE_TYPES, doorways: LIVE_DOORWAYS, villages: [], biomes });
  const required = requiredTilesFor(w, { worlds: [w], links: [] }, row, LIVE_DOORWAYS);
  return assertNavigable(cfg, required);
}

test('the OLD seed (2005) is sealed with the real doorways, at the world\'s real size -- pins the regression', () => {
  const problems = checkSeed(OLD_SEED, MIRE_SPEC.width, MIRE_SPEC.height);
  assert.notEqual(problems.length, 0,
    'expected seed 2005 to reproduce the sealed-pocket defect against the live doorways; ' +
    'if this now passes, the defect this migration fixes may already be gone and the migration should be reconsidered');
});

// NOT a check of NEW_SEED (2011): that seed was hand-picked for the OLD
// 64x64 mire and is itself sealed at the size this branch introduced (see
// the migration's header comment -- verified offline: seed 2011 at 96x96
// fails with "doorway E at (48,95) is unreachable"). What actually ships is
// whatever hub-vale.map.json's mire entry says, so that is what this checks.
test(`the world's current spec seed (${MIRE_SPEC.seed}) is navigable with the real doorways at its real size (${MIRE_SPEC.width}x${MIRE_SPEC.height})`, () => {
  const problems = checkSeed(MIRE_SPEC.seed, MIRE_SPEC.width, MIRE_SPEC.height);
  assert.deepEqual(problems, [], `unexpected navigability problem(s) at seed ${MIRE_SPEC.seed}:\n  - ${problems.join('\n  - ')}`);
});

// --- Live database ---

const DB_URL = process.env.TEST_DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

function requireTestDb(t, why) {
  if (!process.env.TEST_DATABASE_URL) {
    const msg = `TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (${why})`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return false;
  }
  return true;
}

async function openPool() {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 2 });
  try { await pool.query('SELECT 1'); return pool; }
  catch (err) { await pool.end().catch(() => {}); return { unreachable: err.message }; }
}

test('applying up() in a transaction touches only Blackfen Sinks\' seed', async (t) => {
  if (!requireTestDb(t, 'runs the migration SQL against a real worlds table')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`NO DATABASE at ${DB_URL}`); return; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = (await client.query('SELECT id, name, seed FROM worlds ORDER BY id')).rows;

    const sql = emitted(mig.up);
    for (const stmt of sql.split('\n').filter(Boolean)) {
      await client.query(stmt);
    }

    const after = (await client.query('SELECT id, name, seed FROM worlds ORDER BY id')).rows;
    assert.equal(before.length, after.length, 'up() must not add or remove world rows');

    const beforeByName = new Map(before.map((r) => [r.name, r.seed]));
    const changed = after.filter((r) => String(beforeByName.get(r.name)) !== String(r.seed));

    // The migration is applied idempotently (WHERE seed != NEW_SEED), and
    // this test runs against the real dev database where it may already
    // have landed -- so "nothing changed" is a VALID outcome, not just
    // "not seeded at all". Only a change to some OTHER world is a failure.
    if (beforeByName.get('Blackfen Sinks') === undefined || String(beforeByName.get('Blackfen Sinks')) === String(NEW_SEED)) {
      assert.deepEqual(changed, [],
        'Blackfen Sinks is absent or already at the new seed -- up() must be a no-op here');
    } else {
      assert.deepEqual(changed.map((r) => r.name), ['Blackfen Sinks']);
      assert.equal(String(changed[0].seed), String(NEW_SEED));
    }
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});

test('against the live database: Blackfen Sinks is navigable with its real doorways at its real seed', async (t) => {
  if (!requireTestDb(t, 'reads live map_links/biomes for Blackfen Sinks')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`NO DATABASE at ${DB_URL}`); return; }
  try {
    const wr = await pool.query(`SELECT id, seed, width, height, chunk_size, biome_cell, biomes, entry_spawn
                                    FROM worlds WHERE name = 'Blackfen Sinks'`);
    if (wr.rows.length === 0) { t.skip('Blackfen Sinks not seeded in this database'); return; }
    const world = wr.rows[0];

    const linkRows = await fetchLinks(pool, world.id);
    const doorways = linkRows.map((l) => l.edge);
    // Not pinned to a specific edge set: hub-vale.map.json only ever declares
    // one (S), the live topology has carried a different real pair (N, E) at
    // least once already (see 1714440164000's commit message), and a freshly
    // seeded database is not guaranteed to reproduce either. What matters is
    // that SOME doorways exist and whatever they are gets fed into the same
    // check the client/server actually rely on -- a world with zero doorways
    // would make requiredTilesFor produce nothing to check at all.
    assert.notEqual(doorways.length, 0, 'Blackfen Sinks has no live doorways to check navigability against');
    // Fetched live, not hardcoded to [], so a village added to Blackfen Sinks
    // after this test is written is still exercised -- a village box carves
    // a room out of the interior and could reshape reachability.
    const villages = await fetchVillages(pool, world.id);

    const { rows: biomeRows } = await pool.query(
      `SELECT name, terrain_tiles, flora_types, creature_types, palette, art_style, exclusions, color
         FROM biomes WHERE name = ANY($1::text[])`,
      [world.biomes],
    );
    const biomesByName = new Map(biomeRows.map((b) => [b.name, b]));
    const biomes = world.biomes.map((n) => biomesByName.get(n)).filter(Boolean);
    assert.equal(biomes.length, world.biomes.length, 'a live biome referenced by Blackfen Sinks is missing from the biomes table');

    const { rows: tileRows } = await pool.query('SELECT name, walkable FROM tile_types');
    const tileTypes = Object.fromEntries(tileRows.map((r) => [r.name, { walkable: r.walkable }]));

    // The world's ACTUAL live seed, not the migration's NEW_SEED (2011) --
    // that seed was only ever verified at the old 64x64 size (offline it
    // fails at 96x96, the size this branch moved mire to; see the migration
    // file's header). Whatever seed is really sitting in the database is the
    // one a player actually experiences, so that is what gets checked.
    const row = {
      seed: world.seed, chunk_size: world.chunk_size, width: world.width, height: world.height,
      entry_spawn: world.entry_spawn, biome_cell: world.biome_cell,
      level_min: 1, level_max: 1,
    };
    const cfg = buildWorldGenConfig({ row, tileTypes, doorways, villages, biomes });
    const w = { key: 'mire', name: 'Blackfen Sinks', width: world.width, height: world.height, entry_spawn: world.entry_spawn };
    const required = requiredTilesFor(w, { worlds: [w], links: [] }, row, doorways);
    const problems = assertNavigable(cfg, required);
    assert.deepEqual(problems, [], `navigability problem(s) against the live DB's tile/biome catalogs:\n  - ${problems.join('\n  - ')}`);
  } finally {
    await pool.end();
  }
});
