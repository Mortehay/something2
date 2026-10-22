const test = require('node:test');
const assert = require('node:assert');
const { Client } = require('pg');
const MigrationBuilder = require('node-pg-migrate/dist/migration-builder').default;
const mig = require('../migrations/1714440825000_biome_scenery.js');
const {
  SCENERY_TYPES, SPAWN_TILE_ADDITIONS, BIOME_SCENERY, EXISTING_BLOCK_RADIUS,
} = require('../seeds/data/sceneryCatalog.js');

// Every statement (fixtures, up, down, assertions) runs on ONE client inside
// ONE transaction that is ALWAYS rolled back, so nothing here is committed and
// the test is re-runnable whatever state the database is in. Refuses to run
// without TEST_DATABASE_URL: it ALTERs entity_types and biomes.
const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to touch a real database' : false;

async function run(client, direction) {
  const pgm = new MigrationBuilder({}, {}, false, { debug() {}, info() {}, warn() {}, error() {} });
  mig[direction](pgm);
  for (const sql of pgm.getSqlSteps()) await client.query(sql);
}

// `body` gets a client in a fresh rolled-back transaction, with the five
// columns and the scenery rows removed first so `up` starts from the pre-
// migration shape even on a database where it has already been applied.
//
// LOCKING. down/up ALTER entity_types and biomes, and every catalog test running
// in parallel (seed_catalogs_db, seed_auras_db, ...) touches the same tables in
// its own order. Taking the locks implicitly, one statement at a time, made
// this file the hub of deadlock cycles in which an innocent PEER was the victim
// (full suite: seed_catalogs_db / seed_auras_db red in 3-4 of 4 runs, green at
// 41b10a9d; reproduced 2/2 by running the three files together). So both
// tables are locked ACCESS EXCLUSIVE up front, with lock_timeout BELOW
// deadlock_timeout (1s): this session always gives up its own wait before
// Postgres' detector runs, and retries the whole transaction from BEGIN. Once
// it holds both locks it never waits again, so it cannot close a cycle.
// A time budget, not a try count: under the full suite a peer's long seeding
// transaction can hold a conflicting lock for well over a minute. Kept well
// inside the per-file --test-timeout (420s).
const LOCK_DEADLINE_MS = 240000;
async function inTxn(body) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const deadline = Date.now() + LOCK_DEADLINE_MS;
    for (let attempt = 1; ; attempt++) {
      await client.query('BEGIN');
      try {
        await client.query("SET LOCAL lock_timeout = '750ms'");
        await client.query('LOCK TABLE entity_types, biomes IN ACCESS EXCLUSIVE MODE');
        await client.query('SET LOCAL lock_timeout = 0');
        break;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if ((err.code !== '55P03' && err.code !== '40P01') || Date.now() >= deadline) {
          throw new Error(`scenery_migration_db: could not lock entity_types+biomes after ${attempt} tries in ${LOCK_DEADLINE_MS / 1000}s `
            + `(a peer held a conflicting lock for the whole window): ${err.message}`);
        }
        await new Promise((r) => { setTimeout(r, 100 + Math.floor(Math.random() * 200)); });
      }
    }
    await client.query('DELETE FROM entity_types WHERE name = ANY($1)', [SCENERY_TYPES.map((t) => t.name)]);
    await run(client, 'down');
    await body(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
}

const flora = async (c, name) => (await c.query('SELECT flora_types FROM biomes WHERE name = $1', [name])).rows[0].flora_types;

test('up adds the five columns with their defaults', { skip }, () => inTxn(async (c) => {
  await run(c, 'up');
  const cols = await c.query(
    `SELECT table_name, column_name, is_nullable, column_default FROM information_schema.columns
     WHERE (table_name = 'entity_types' AND column_name IN ('scenery_layer','block_radius','max_per_tile'))
        OR (table_name = 'biomes' AND column_name IN ('feature_density','cover_density'))`);
  const by = Object.fromEntries(cols.rows.map((r) => [`${r.table_name}.${r.column_name}`, r]));
  assert.equal(Object.keys(by).length, 5);
  assert.match(by['entity_types.scenery_layer'].column_default, /'feature'/);
  assert.equal(by['entity_types.scenery_layer'].is_nullable, 'NO');
  assert.equal(by['entity_types.block_radius'].is_nullable, 'YES');
  assert.equal(by['entity_types.block_radius'].column_default, null);
  assert.match(by['entity_types.max_per_tile'].column_default, /^2/);
  assert.equal(by['biomes.feature_density'].is_nullable, 'YES');
  assert.equal(by['biomes.feature_density'].column_default, null);
  assert.equal(by['biomes.cover_density'].is_nullable, 'YES');
  assert.equal(by['biomes.cover_density'].column_default, null);
  // the layer CHECK is live
  await c.query('SAVEPOINT s');
  await assert.rejects(c.query("UPDATE entity_types SET scenery_layer = 'sky' WHERE name = 'Tree'"), (e) => e.code === '23514');
  await c.query('ROLLBACK TO s');
}));

test('up inserts every SCENERY_TYPES row and sets EXISTING_BLOCK_RADIUS', { skip }, () => inTxn(async (c) => {
  await run(c, 'up');
  const rows = (await c.query('SELECT * FROM entity_types WHERE name = ANY($1)', [SCENERY_TYPES.map((t) => t.name)])).rows;
  assert.equal(rows.length, SCENERY_TYPES.length);
  const by = new Map(rows.map((r) => [r.name, r]));
  for (const t of SCENERY_TYPES) {
    const r = by.get(t.name);
    assert.equal(r.scenery_layer, t.scenery_layer, t.name);
    assert.equal(r.walkable, t.walkable, t.name);
    assert.equal(r.block_radius, t.block_radius, t.name);
    assert.equal(r.max_per_tile, t.max_per_tile, t.name);
    assert.deepEqual(r.spawn_tiles, t.spawn_tiles, t.name);
    assert.equal(r.is_creature, false);
    assert.equal(r.prompt, t.prompt, t.name);
    assert.equal(r.image, null, `${t.name} must ship without art`);
  }
  const ex = (await c.query('SELECT name, block_radius FROM entity_types WHERE name = ANY($1)', [Object.keys(EXISTING_BLOCK_RADIUS)])).rows;
  assert.equal(ex.length, Object.keys(EXISTING_BLOCK_RADIUS).length);
  for (const r of ex) assert.equal(r.block_radius, EXISTING_BLOCK_RADIUS[r.name], r.name);
  // existing decorations gained floors without losing any
  const stone = (await c.query("SELECT spawn_tiles FROM entity_types WHERE name = 'Stone'")).rows[0].spawn_tiles;
  assert.deepEqual(stone.slice(0, 3), ['earth', 'rocks', 'sand']);
  for (const t of SPAWN_TILE_ADDITIONS.Stone) assert.ok(stone.includes(t), `Stone lacks ${t}`);
  // cover density landed
  const d = (await c.query('SELECT name, cover_density FROM biomes')).rows;
  for (const r of d) assert.equal(r.cover_density, BIOME_SCENERY[r.name].cover_density, r.name);
}));

test('up appends to flora_types without removing or reordering', { skip }, () => inTxn(async (c) => {
  const custom = ['bush', 'my_custom_thing', 'Stone', 'pebbles'];
  await c.query("UPDATE biomes SET flora_types = $1::jsonb WHERE name = 'Meadow'", [JSON.stringify(custom)]);
  const before = {};
  for (const name of Object.keys(BIOME_SCENERY)) before[name] = await flora(c, name);
  await run(c, 'up');
  const after = await flora(c, 'Meadow');
  assert.deepEqual(after.slice(0, custom.length), custom, 'custom list must be a prefix');
  assert.equal(new Set(after).size, after.length, 'no duplicates (pebbles was already present)');
  for (const n of BIOME_SCENERY.Meadow.add) assert.ok(after.includes(n), `Meadow lacks ${n}`);
  for (const name of Object.keys(BIOME_SCENERY)) {
    const f = await flora(c, name);
    assert.deepEqual(f.slice(0, before[name].length), before[name], `${name} prefix changed`);
    for (const n of BIOME_SCENERY[name].add) assert.ok(f.includes(n), `${name} lacks ${n}`);
  }
}));

test('up is idempotent', { skip }, () => inTxn(async (c) => {
  const snap = async () => ({
    types: (await c.query('SELECT * FROM entity_types WHERE name = ANY($1) OR name = ANY($2) ORDER BY name', [
      SCENERY_TYPES.map((t) => t.name), Object.keys(SPAWN_TILE_ADDITIONS)])).rows,
    biomes: (await c.query('SELECT name, flora_types, feature_density, cover_density FROM biomes ORDER BY name')).rows,
  });
  await run(c, 'up');
  const once = await snap();
  await run(c, 'up');
  const twice = await snap();
  assert.equal(once.types.length, SCENERY_TYPES.length + Object.keys(SPAWN_TILE_ADDITIONS).length);
  // updated_at may be bumped by a trigger; compare everything else
  const strip = (rows) => rows.map(({ updated_at, ...r }) => r);
  assert.deepEqual(strip(twice.types), strip(once.types));
  assert.deepEqual(twice.biomes, once.biomes);
}));

test('an admin-edited type and biome are not overwritten', { skip }, () => inTxn(async (c) => {
  await run(c, 'up');
  await c.query("UPDATE entity_types SET chance = 0.77, spawn_tiles = '[\"grass\"]'::jsonb, prompt = 'my prompt', block_radius = 5 WHERE name = 'boulder'");
  await c.query("UPDATE entity_types SET prompt = '' WHERE name = 'clover'");
  await c.query("UPDATE entity_types SET block_radius = 3 WHERE name = 'Tree'");
  await c.query("UPDATE biomes SET cover_density = 2.9, flora_types = '[\"bush\"]'::jsonb WHERE name = 'Meadow'");
  await run(c, 'up');
  const b = (await c.query("SELECT chance, spawn_tiles, prompt, block_radius FROM entity_types WHERE name = 'boulder'")).rows[0];
  assert.equal(b.chance, 0.77);
  assert.deepEqual(b.spawn_tiles, ['grass']);
  assert.equal(b.prompt, 'my prompt');
  assert.equal(b.block_radius, 5);
  // an EMPTY prompt is the one thing a re-run fills
  const clover = (await c.query("SELECT prompt FROM entity_types WHERE name = 'clover'")).rows[0];
  assert.equal(clover.prompt, SCENERY_TYPES.find((t) => t.name === 'clover').prompt);
  assert.equal((await c.query("SELECT block_radius FROM entity_types WHERE name = 'Tree'")).rows[0].block_radius, 3);
  const m = (await c.query("SELECT cover_density FROM biomes WHERE name = 'Meadow'")).rows[0];
  assert.equal(m.cover_density, 2.9);
}));

test('down drops the columns and leaves rows alone', { skip }, () => inTxn(async (c) => {
  await run(c, 'up');
  await run(c, 'down');
  const left = await c.query(
    `SELECT 1 FROM information_schema.columns WHERE column_name IN
     ('scenery_layer','block_radius','max_per_tile','feature_density','cover_density')
       AND table_name IN ('entity_types','biomes')`);
  assert.equal(left.rowCount, 0);
  const n = await c.query('SELECT count(*)::int AS n FROM entity_types WHERE name = ANY($1)', [SCENERY_TYPES.map((t) => t.name)]);
  assert.equal(n.rows[0].n, SCENERY_TYPES.length);
}));

test('seedOneBiome writes densities for new rows and keeps admin-tuned ones', { skip }, () => inTxn(async (c) => {
  await run(c, 'up');
  const { seedOneBiome } = require('../scripts/seed-catalogs.js');
  const { STARTER_BIOMES } = require('../seeds/data/biomes.js');
  const meadow = STARTER_BIOMES.find((b) => b.name === 'Meadow');
  // fresh row: densities come from the seed
  await c.query("DELETE FROM biomes WHERE name = 'Meadow'");
  await seedOneBiome(c, { ...meadow, feature_density: 0.4 });
  let r = (await c.query("SELECT feature_density, cover_density, flora_types FROM biomes WHERE name = 'Meadow'")).rows[0];
  assert.equal(r.feature_density, 0.4);
  assert.equal(r.cover_density, meadow.cover_density);
  assert.deepEqual(r.flora_types, meadow.flora_types);
  // admin tuned both: a re-seed leaves them
  await c.query("UPDATE biomes SET feature_density = 0.9, cover_density = 0.5 WHERE name = 'Meadow'");
  await seedOneBiome(c, { ...meadow, feature_density: 0.4 });
  r = (await c.query("SELECT feature_density, cover_density FROM biomes WHERE name = 'Meadow'")).rows[0];
  assert.equal(r.feature_density, 0.9);
  assert.equal(r.cover_density, 0.5);
}));

test('up sets feature_density from the catalogue only where it is NULL', { skip }, () => inTxn(async (c) => {
  await run(c, 'up');
  const dens = async () => Object.fromEntries(
    (await c.query('SELECT name, feature_density FROM biomes')).rows.map((r) => [r.name, r.feature_density]));
  const first = await dens();
  for (const [name, s] of Object.entries(BIOME_SCENERY)) assert.equal(first[name], s.feature_density, name);
  assert.ok(Object.values(BIOME_SCENERY).some((s) => s.feature_density !== null), 'some biomes are tuned');
  assert.ok(Object.values(BIOME_SCENERY).some((s) => s.feature_density === null), 'untuned biomes stay NULL (today\'s look)');
  // an admin value wins over a re-run; a NULL is filled again
  await c.query("UPDATE biomes SET feature_density = 0.77 WHERE name = 'Meadow'");
  await c.query("UPDATE biomes SET feature_density = NULL WHERE name = 'Ossuary'");
  await run(c, 'up');
  const second = await dens();
  assert.equal(second.Meadow, 0.77);
  assert.equal(second.Ossuary, BIOME_SCENERY.Ossuary.feature_density);
  assert.equal(second.Highlands, null);
}));

test('an admin-set cover_density of 0 survives a re-run of the migration fill and the seed', { skip }, () => inTxn(async (c) => {
  await run(c, 'up');
  await c.query("UPDATE biomes SET cover_density = 0 WHERE name = 'Meadow'");
  await run(c, 'up');
  let r = (await c.query("SELECT cover_density FROM biomes WHERE name = 'Meadow'")).rows[0];
  assert.equal(r.cover_density, 0, 'migration fill refilled a deliberate 0');
  const { seedOneBiome } = require('../scripts/seed-catalogs.js');
  const { STARTER_BIOMES } = require('../seeds/data/biomes.js');
  const meadow = STARTER_BIOMES.find((b) => b.name === 'Meadow');
  assert.ok(meadow.cover_density > 0);
  await seedOneBiome(c, meadow);
  r = (await c.query("SELECT cover_density FROM biomes WHERE name = 'Meadow'")).rows[0];
  assert.equal(r.cover_density, 0, 'seed refilled a deliberate 0');
  // but an unset (NULL) one is filled
  await c.query("UPDATE biomes SET cover_density = NULL WHERE name = 'Meadow'");
  await seedOneBiome(c, meadow);
  r = (await c.query("SELECT cover_density FROM biomes WHERE name = 'Meadow'")).rows[0];
  assert.equal(r.cover_density, meadow.cover_density);
}));

// The rows survive `down` (only the columns go), so the next `up` re-creates the
// columns at their defaults over rows that already exist. Without a re-assert
// every cover type would silently become a 'feature' with no radius.
test('up -> down -> up with the rows present restores layer, radius and max', { skip }, () => inTxn(async (c) => {
  await run(c, 'up');
  await run(c, 'down');
  const present = await c.query('SELECT count(*)::int AS n FROM entity_types WHERE name = ANY($1)', [SCENERY_TYPES.map((t) => t.name)]);
  assert.equal(present.rows[0].n, SCENERY_TYPES.length, 'down must leave the rows in place for this test to mean anything');
  await run(c, 'up');
  const by = new Map((await c.query('SELECT name, scenery_layer, block_radius, max_per_tile FROM entity_types WHERE name = ANY($1)',
    [SCENERY_TYPES.map((t) => t.name)])).rows.map((r) => [r.name, r]));
  assert.ok(SCENERY_TYPES.some((t) => t.scenery_layer === 'cover'), 'catalogue must contain cover types');
  for (const t of SCENERY_TYPES) {
    const r = by.get(t.name);
    assert.equal(r.scenery_layer, t.scenery_layer, `${t.name} layer`);
    assert.equal(r.block_radius, t.block_radius, `${t.name} radius`);
    assert.equal(r.max_per_tile, t.max_per_tile, `${t.name} max`);
  }
  const ex = (await c.query('SELECT name, block_radius FROM entity_types WHERE name = ANY($1)', [Object.keys(EXISTING_BLOCK_RADIUS)])).rows;
  for (const r of ex) assert.equal(r.block_radius, EXISTING_BLOCK_RADIUS[r.name], r.name);
}));

test('a plain re-run of up keeps admin edits to the catalogue rows', { skip }, () => inTxn(async (c) => {
  await run(c, 'up');
  const cover = SCENERY_TYPES.find((t) => t.scenery_layer === 'cover').name;
  await c.query("UPDATE entity_types SET scenery_layer = 'feature', block_radius = 33, max_per_tile = 7 WHERE name = $1", [cover]);
  await run(c, 'up');
  const r = (await c.query('SELECT scenery_layer, block_radius, max_per_tile FROM entity_types WHERE name = $1', [cover])).rows[0];
  assert.deepEqual({ ...r }, { scenery_layer: 'feature', block_radius: 33, max_per_tile: 7 });
}));
