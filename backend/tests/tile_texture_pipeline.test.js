const test = require('node:test');
const assert = require('node:assert');
const { pickBiome, parseArgs } = require('../scripts/generate-tile-textures.js');
const { seededKey } = require('../scripts/seed-tile-textures.js');
const { DEFAULT_TILE_TYPES } = require('../seeds/data/tileTypes.js');

// The three pure decisions in the tile-texture pipeline. Everything else in
// those two scripts is I/O against Postgres and MinIO and is exercised by
// running them; these are the parts that can be wrong silently.

test('pickBiome is deterministic: lowest biome id wins, not row order', () => {
  const biomes = [
    { id: 9, name: 'Late', terrain_tiles: ['grass', 'sand'] },
    { id: 2, name: 'Early', terrain_tiles: ['grass'] },
    { id: 5, name: 'Middle', terrain_tiles: ['grass'] },
  ];
  assert.equal(pickBiome('grass', biomes).name, 'Early');
  // Reversed input must not change the answer -- if it does, adding an
  // unrelated biome could silently re-style an existing tile on the next run.
  assert.equal(pickBiome('grass', [...biomes].reverse()).name, 'Early');
});

test('pickBiome returns null for a tile no biome claims', () => {
  const biomes = [{ id: 1, name: 'Meadow', terrain_tiles: ['grass'] }];
  // Structural tiles (roads, gates, walls) are stamped, never WFC-placed, so
  // they appear in no biome's terrain_tiles. They must keep no art context
  // rather than borrow an unrelated palette.
  assert.equal(pickBiome('road_stone', biomes), null);
  assert.equal(pickBiome('village_gate', biomes), null);
});

test('pickBiome tolerates a biome row with no terrain_tiles array', () => {
  const biomes = [{ id: 1, name: 'Broken', terrain_tiles: null },
    { id: 2, name: 'Fine', terrain_tiles: ['grass'] }];
  assert.equal(pickBiome('grass', biomes).name, 'Fine');
});

test('every structural tile in the real catalog is one pickBiome leaves alone', () => {
  // Guards the pairing rather than the list: if a road or gate ever enters a
  // biome's terrain_tiles it would start inheriting that biome's palette, and
  // tile_catalog_integrity's rules say it should not be terrain at all.
  const { STARTER_BIOMES } = require('../seeds/data/biomes.js');
  // cave_wall is deliberately NOT in this set. It is impassable and extruded
  // like map_wall, but seeds/data/tileTypes.js bands it into the ten deep
  // biomes on purpose, so it SHOULD inherit one's art context. The stamped
  // tiles below are the ones no biome may claim.
  const structural = DEFAULT_TILE_TYPES
    .filter((t) => /^road_|^map_|^village_/.test(t.name) || t.name === 'wooden_wall')
    .map((t) => t.name);
  assert.ok(structural.length >= 5);
  for (const name of structural) {
    assert.equal(pickBiome(name, STARTER_BIOMES.map((b, i) => ({ ...b, id: i + 1 }))), null,
      `${name} is claimed by a biome but is structural`);
  }
});

test('cave_wall DOES take a biome context, unlike the stamped structural tiles', () => {
  // The counterpart to the test above, kept separate so the intent is legible:
  // banding cave_wall into the deep biomes is a deliberate catalog decision,
  // and if it is ever removed this fails rather than silently un-styling it.
  const { STARTER_BIOMES } = require('../seeds/data/biomes.js');
  const withIds = STARTER_BIOMES.map((b, i) => ({ ...b, id: i + 1 }));
  assert.ok(pickBiome('cave_wall', withIds), 'cave_wall should inherit a deep biome');
});

test('parseArgs reads the flags the Makefile passes', () => {
  const a = parseArgs(['--provider', 'desktop gpu', '--force', '--only', 'grass, sand', '--no-pin']);
  assert.equal(a.provider, 'desktop gpu');
  assert.equal(a.force, true);
  assert.equal(a.pin, false);
  assert.deepEqual(a.only, ['grass', 'sand']);   // whitespace trimmed
  assert.equal(a.dryRun, false);
});

test('parseArgs defaults to pinning and to no provider', () => {
  const a = parseArgs([]);
  assert.equal(a.pin, true, 'pinning is the default -- --no-pin opts out');
  assert.equal(a.provider, null, 'no provider means "use the active one"');
  assert.equal(a.force, false);
});

test('seededKey is stable and namespaced away from job-scoped keys', () => {
  // Stability is the point: re-seeding overwrites in place instead of
  // accumulating a new object per run.
  assert.equal(seededKey('sprites', 'grass'), 'sprites/tiles/grass/seeded/static.png');
  assert.equal(seededKey('sprites', 'grass'), seededKey('sprites', 'grass'));
  assert.ok(seededKey('sprites', 'grass').includes('/seeded/'),
    'seeded textures must not reuse a generating machine\'s job ids');
});

test('seededKey sanitises a name that could escape its prefix', () => {
  assert.equal(seededKey('sprites', '../../etc/passwd'), 'sprites/tiles/______etc_passwd/seeded/static.png');
  assert.ok(!seededKey('sprites', '../x').includes('..'));
});
