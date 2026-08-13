const test = require('node:test');
const assert = require('node:assert');
const { buildWorldGenConfig } = require('../src/services/worldGenConfig');
const { worldConfig, generateRegion } = require('../src/services/mapService');
const { buildSafeContext } = require('../src/services/safeRegion');

const ROW = {
  id: 'w1', seed: '777', chunk_size: 16, width: 30, height: 30,
  entry_spawn: { x: 1500, y: 1500 }, biome_cell: null,
  level_min: 3, level_max: 8,
};
const TILE_TYPES = {
  grass: { walkable: true, speed: 1 },
  // Deliberately not "sand": PATH_NAME_RE in mapService.js treats any tile
  // name matching /path|dirt|road|trail|earth|sand/i as the auto-detected
  // path tile (see biomeSampler.test.js's `pathTile: 'sand'` case), and
  // buildWorldGenConfig doesn't pass a pathTile override through. "sand"
  // here would get carved as a path tile regardless of biome, breaking the
  // "belongs to no biome" assertion below for a reason unrelated to biomes.
  stone: { walkable: true, speed: 1 },
  snow: { walkable: true, speed: 1 },
};
const BIOMES = [
  { name: 'Meadow', terrain_tiles: ['grass'], flora_types: ['bush'], creature_types: ['Slime'] },
  { name: 'Frozen Waste', terrain_tiles: ['snow'], flora_types: [], creature_types: ['Bat'] },
];

function cfgArgs(over = {}) {
  return { row: ROW, tileTypes: TILE_TYPES, doorways: [], villages: [], biomes: BIOMES, ...over };
}

test('coerces the seed to a number (the column is bigint -> string)', () => {
  const c = buildWorldGenConfig(cfgArgs());
  assert.strictEqual(c.seed, 777);
});

test('carries every field the generator reads', () => {
  const c = buildWorldGenConfig(cfgArgs());
  assert.deepEqual(Object.keys(c).sort(), [
    'authoredRoads', 'biomeCell', 'biomes', 'chunkSize', 'doorways', 'entry_spawn',
    'height', 'levelMax', 'levelMin', 'safeRects', 'safeRoadRadius',
    'seed', 'tileTypes', 'villages', 'width',
  ]);
  assert.equal(c.chunkSize, 16);
  assert.equal(c.width, 30);
  assert.equal(c.height, 30);
  assert.deepEqual(c.entry_spawn, { x: 1500, y: 1500 });
  assert.deepEqual(c.biomes, BIOMES);
});

test('maps level_min/level_max to the levelMin/levelMax the spawn paths read', () => {
  const c = buildWorldGenConfig(cfgArgs());
  assert.equal(c.levelMin, 3);
  assert.equal(c.levelMax, 8);
});

test('a row with no level band passes through as undefined, not defaulted', () => {
  // rollCreatureLevel (creatureLevel.js) treats a non-integer band as "roll
  // level 1" -- this module must not silently invent a band, just relay
  // whatever the row has.
  const { level_min, level_max, ...rowWithoutBand } = ROW;
  const c = buildWorldGenConfig(cfgArgs({ row: rowWithoutBand }));
  assert.strictEqual(c.levelMin, undefined);
  assert.strictEqual(c.levelMax, undefined);
});

test('a null biome_cell reaches worldConfig as null so it derives from bounds', () => {
  const c = buildWorldGenConfig(cfgArgs());
  assert.equal(c.biomeCell, null);
  assert.equal(worldConfig(c).biomeCell, 10); // floor(min(30,30)/3)
});

test('an explicit biome_cell is passed through', () => {
  const c = buildWorldGenConfig(cfgArgs({ row: { ...ROW, biome_cell: 15 } }));
  assert.equal(c.biomeCell, 15);
  assert.equal(worldConfig(c).biomeCell, 15);
});

test('the built config generates real biome-restricted terrain', () => {
  const c = buildWorldGenConfig(cfgArgs());
  const grid = generateRegion(c, 2, 2, 20, 20);
  const seen = new Set(grid.flat());
  assert.ok(!seen.has('stone'), 'stone belongs to no biome here and must not appear');
  assert.ok(seen.has('grass') || seen.has('snow'));
});

test('a missing biome_cell field produces exactly null, not undefined', () => {
  // assert.equal (loose ==) treats null and undefined as equal, so the tests
  // above alone don't pin this: a `biomeCell: row.biome_cell` passthrough
  // (dropping the Number.isFinite guard entirely) still satisfies
  // `assert.equal(c.biomeCell, null)` above because `undefined == null`, yet
  // would hand worldConfig `undefined` -- the two are NOT equivalent inputs
  // to worldConfig's `Number.isFinite(world.biomeCell)` check, they just
  // happen to both fail it the same way here. Pin the exact value with
  // assert.strictEqual so removing the guard fails loudly.
  const { biome_cell, ...rowWithoutBiomeCell } = ROW;
  const c = buildWorldGenConfig(cfgArgs({ row: rowWithoutBiomeCell }));
  assert.strictEqual(c.biomeCell, null);
  assert.strictEqual(worldConfig(c).biomeCell, 10); // floor(min(30,30)/3)
});

test('a world with no biomes builds an empty biome list, not undefined', () => {
  const c = buildWorldGenConfig(cfgArgs({ biomes: [] }));
  assert.deepEqual(c.biomes, []);
  assert.deepEqual(worldConfig(c).biomes, []);
});

test('safe-region columns reach the generator config, converted to camelCase', () => {
  const cfg = buildWorldGenConfig({
    row: {
      ...ROW,
      safe_road_radius: 2,
      safe_rects: [{ min_row: 4, min_col: 5, width: 3, height: 2 }],
    },
    tileTypes: TILE_TYPES, doorways: [], villages: [], biomes: BIOMES,
  });
  assert.equal(cfg.safeRoadRadius, 2);
  assert.deepEqual(cfg.safeRects, [{ minRow: 4, minCol: 5, width: 3, height: 2 }]);
});

test('a row with no safe-region columns yields the opted-out config', () => {
  // Every world that existed before this feature. The generator must see 0 and
  // [], not undefined -- worldConfig would normalize undefined the same way,
  // but a missing mapping here is exactly the silent client/server divergence
  // buildWorldGenConfig's header warns about.
  const cfg = buildWorldGenConfig({
    row: ROW, tileTypes: TILE_TYPES, doorways: [], villages: [], biomes: BIOMES,
  });
  assert.equal(cfg.safeRoadRadius, 0);
  assert.deepEqual(cfg.safeRects, []);
});

test('worldConfig normalizes the safe-region fields it is handed', () => {
  const cfg = worldConfig({
    seed: 1, width: 20, height: 20, tileTypes: TILE_TYPES,
    safeRoadRadius: 3, safeRects: [{ minRow: 1, minCol: 1, width: 2, height: 2 }],
  });
  assert.equal(cfg.safeRoadRadius, 3);
  assert.deepEqual(cfg.safeRects, [{ minRow: 1, minCol: 1, width: 2, height: 2 }]);

  const bare = worldConfig({ seed: 1, width: 20, height: 20, tileTypes: TILE_TYPES });
  assert.equal(bare.safeRoadRadius, 0);
  // safeRects is deliberately NOT coerced here any more (SOMET-288 review,
  // finding 4). safeRegion.buildSafeContext is the single validator and it
  // throws on a malformed value; a `?? []` at this layer swallowed the bad
  // value first and turned an authored-but-broken rectangle into no rectangle
  // at all. An absent one is still the opt-out -- buildSafeContext maps
  // undefined to [], covered in safe_region.test.js.
  assert.equal(bare.safeRects, undefined);
});

// The bare `.map()` this replaced died as "Cannot read properties of null
// (reading 'min_row')" -- a TypeError from one layer BELOW the validator that
// was hardened against a null entry, naming neither the column nor the world.
test('a null entry in worlds.safe_rects survives conversion so the validator can name it', () => {
  const cfg = buildWorldGenConfig({
    row: { ...ROW, safe_rects: [null] },
    tileTypes: TILE_TYPES, doorways: [], villages: [], biomes: BIOMES,
  });
  assert.deepEqual(cfg.safeRects, [null]);
  assert.throws(() => buildSafeContext({ safeRects: cfg.safeRects }),
    /safeRects\[0\] must be an object/);
});

test('a non-array worlds.safe_rects is rejected at conversion, naming the column', () => {
  assert.throws(
    () => buildWorldGenConfig({
      row: { ...ROW, safe_rects: { min_row: 1, min_col: 1, width: 2, height: 2 } },
      tileTypes: TILE_TYPES, doorways: [], villages: [], biomes: BIOMES,
    }),
    /worlds\.safe_rects must be a jsonb array/,
  );
});

// ---------------------------------------------------------------------------
// The recurrence guard for SOMET-288 review finding 1.
//
// buildWorldGenConfig's header promises that adding a field HERE reaches both
// consumers by construction. That promise holds for every caller that says
// `SELECT *` -- index.js's chunk/preview/overview routes, worldPopulation's
// callers -- and breaks for the ONE that spells its columns out: the
// authority's loadWorld. safe_road_radius and safe_rects were added to this
// builder and not to that query, so the live authority silently built every
// world with `safeRoadRadius: 0` / `safeRects: []` -- `Number(undefined) || 0`
// and `Array.isArray(undefined)`, defaults, no error, nothing in any log.
//
// The behavioural proof lives in authority_use_field_chest_integration.test.js
// (a real loadWorld, a real `use`). This is the cheap structural one: it reads
// the two files as TEXT and fails for the NEXT column too, which is what would
// have caught the original defect at the moment it was introduced.
// ---------------------------------------------------------------------------
const fs = require('node:fs');
const pathMod = require('node:path');

test("the authority's world SELECT names every column buildWorldGenConfig reads", () => {
  const src = (rel) => fs.readFileSync(pathMod.join(__dirname, '..', 'src', rel), 'utf8');

  // Every `row.<column>` the builder dereferences.
  const consumed = new Set(
    [...src('services/worldGenConfig.js').matchAll(/\brow\.([a-z_]+)/g)].map((m) => m[1]));

  // loadWorld's query, matched on its distinctive shape rather than a line
  // number so this survives edits above it.
  const q = /'SELECT ([^']*?) FROM worlds WHERE id = \$1'/.exec(src('authority/server.js'));
  assert.ok(q, "could not find loadWorld's worlds SELECT — has the query been reshaped?");
  const selected = new Set(q[1].split(',').map((c) => c.trim()));

  // Non-vacuous: both sides must be real, and the two columns this guard was
  // written for must actually be among the ones it is checking.
  assert.ok(consumed.size >= 8, `only found ${consumed.size} consumed columns — the scan is broken`);
  assert.ok(consumed.has('safe_road_radius') && consumed.has('safe_rects'),
    'the scan did not see the safe-territory columns the builder reads');

  const missing = [...consumed].filter((c) => !selected.has(c));
  assert.deepEqual(missing, [],
    `authority/server.js's loadWorld SELECT omits ${missing.join(', ')} -- `
    + 'buildWorldGenConfig reads them, so the live authority would silently '
    + 'build every world with those fields at their defaults');
});
