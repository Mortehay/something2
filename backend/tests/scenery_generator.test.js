const test = require('node:test');
const assert = require('node:assert');
const {
  worldConfig, generateChunk, generateChunkDecorations, collectPathCells,
  DEFAULT_BLOCK_RADIUS,
} = require('../src/services/mapService');

const TILES = {
  grass: { walkable: true, speed: 1 },
  dirt: { walkable: true, speed: 1 },
};
function biome(over = {}) {
  return {
    name: 'Meadow', terrain_tiles: ['grass'], flora_types: ['Tree', 'Moss'],
    creature_types: [], ...over,
  };
}
function world(over = {}) {
  return {
    seed: 777, chunkSize: 32, width: 32, height: 32, tileTypes: TILES,
    pathTile: 'dirt', noGeneratedRoads: true, biomeCell: 16,
    biomes: [biome()], ...over,
  };
}
const TREE = { name: 'Tree', walkable: false, spawn_tiles: ['grass'], chance: 1, scenery_layer: 'feature', block_radius: 14, max_per_tile: 2 };
const MOSS = { name: 'Moss', walkable: true, spawn_tiles: ['grass'], chance: 1, scenery_layer: 'cover', block_radius: null, max_per_tile: 3 };
const DEFS = [TREE, MOSS];

function gen(w, defs = DEFS, opts) {
  const tiles = generateChunk(w, 0, 0);
  return { tiles, out: generateChunkDecorations(w, 0, 0, tiles, defs, opts) };
}
const feats = (o) => o.filter((d) => d.layer === 'feature');
const covers = (o) => o.filter((d) => d.layer === 'cover');

test('legacy defs with no layer/radius act as features with DEFAULT_BLOCK_RADIUS', () => {
  assert.equal(DEFAULT_BLOCK_RADIUS, 12);
  const legacy = [{ name: 'Tree', walkable: false, spawn_tiles: ['grass'], chance: 1 }];
  const { out } = gen(world({ biomes: [] }), legacy);
  assert.ok(out.length > 0);
  for (const d of out) {
    assert.equal(d.layer, 'feature');
    assert.equal(d.blocking, true);
    assert.equal(d.radius, DEFAULT_BLOCK_RADIUS);
  }
  const walk = [{ name: 'Bush', walkable: true, spawn_tiles: ['grass'], chance: 1 }];
  const { out: o2 } = gen(world({ biomes: [] }), walk);
  assert.ok(o2.length > 0);
  for (const d of o2) { assert.equal(d.blocking, false); assert.equal(d.radius, 0); assert.equal(d.layer, 'feature'); }
});

test('feature anchor keeps its blocking circle inside the tile', () => {
  const { out } = gen(world());
  const f = feats(out).filter((d) => d.blocking);
  assert.ok(f.length > 20);
  for (const d of f) {
    assert.ok(Number.isInteger(d.ox) && Number.isInteger(d.oy));
    assert.ok(d.radius <= d.ox && d.ox <= 100 - d.radius, `ox ${d.ox} r ${d.radius}`);
    assert.ok(d.radius <= d.oy && d.oy <= 100 - d.radius, `oy ${d.oy} r ${d.radius}`);
  }
});

test('a huge block_radius still yields an in-tile anchor', () => {
  const big = [{ ...TREE, block_radius: 50 }];
  const { out } = gen(world(), big);
  assert.ok(out.length > 0);
  for (const d of out) { assert.equal(d.ox, 50); assert.equal(d.oy, 50); }
});

test('feature offsets vary', () => {
  const { out } = gen(world());
  const f = feats(out);
  assert.ok(f.length > 20);
  assert.ok(f.some((d) => d.ox !== 50 || d.oy !== 50));
  assert.ok(new Set(f.map((d) => d.ox)).size > 5);
});

test('at most one feature per tile; cover per tile <= max_per_tile of eligible types', () => {
  const w = world({ biomes: [biome({ cover_density: 3 })] });
  const { out } = gen(w);
  const fc = new Map(), cc = new Map();
  for (const d of out) {
    const m = d.layer === 'feature' ? fc : cc;
    const k = `${d.row},${d.col}`;
    m.set(k, (m.get(k) || 0) + 1);
  }
  for (const n of fc.values()) assert.ok(n <= 1);
  assert.ok(cc.size > 0);
  for (const n of cc.values()) assert.ok(n <= MOSS.max_per_tile, `cover ${n}`);
});

test('cover is never blocking and never on a path cell', () => {
  const w = world({ pathCell: 8, noGeneratedRoads: false, biomes: [biome({ cover_density: 2 })] });
  const cfg = worldConfig(w);
  const paths = collectPathCells(cfg, 0, 0, 32, 32);
  assert.ok(paths.size > 0, 'fixture needs path cells');
  const { out } = gen(w);
  const cv = covers(out);
  assert.ok(cv.length > 0);
  for (const d of cv) {
    assert.equal(d.blocking, false);
    assert.equal(d.radius, 0);
    assert.ok(d.ox >= 10 && d.ox <= 90 && d.oy >= 10 && d.oy <= 90);
    assert.ok(!paths.has(`${d.row},${d.col}`), `cover on path ${d.row},${d.col}`);
  }
});

test('cover ignores the spawn blocker exclusion but features still honour it', () => {
  const w = world({
    biomes: [biome({ cover_density: 2 })],
    entry_spawn: { x: 1650, y: 1650 },
  });
  const { out } = gen(w);
  const near = (d) => Math.abs(d.row - 16) <= 1 && Math.abs(d.col - 16) <= 1;
  assert.ok(covers(out).some(near), 'cover should appear near spawn');
  assert.ok(!feats(out).some((d) => d.blocking && near(d)), 'blocking feature near spawn');
});

test('coverDensity 0 yields no cover; coverDensity 2 yields roughly 2 per eligible tile', () => {
  const none = gen(world({ biomes: [biome({ cover_density: 0 })] })).out;
  assert.equal(covers(none).length, 0);
  const two = gen(world({ biomes: [biome({ cover_density: 2 })] })).out;
  const { tiles } = gen(world());
  let eligible = 0;
  for (const row of tiles) for (const t of row) if (t === 'grass') eligible++;
  const mean = covers(two).length / eligible;
  assert.ok(mean > 1.5 && mean < 2.5, `mean ${mean}`);
});

test('featureDensity scales feature count', () => {
  const count = (fd) => feats(gen(world({ biomes: [biome({ feature_density: fd })] })).out).length;
  const zero = count(0), dflt = count(null), one = count(1);
  assert.equal(zero, 0);
  assert.ok(dflt > 0);
  assert.ok(one > dflt, `${one} vs ${dflt}`);
});

test('biome with only cover flora places cover and no features, no NaN; and the reverse', () => {
  const onlyCover = gen(world({ biomes: [biome({ flora_types: ['Moss'], cover_density: 1.5 })] })).out;
  assert.equal(feats(onlyCover).length, 0);
  assert.ok(covers(onlyCover).length > 0);
  const onlyFeat = gen(world({ biomes: [biome({ flora_types: ['Tree'], cover_density: 2 })] })).out;
  assert.equal(covers(onlyFeat).length, 0);
  assert.ok(feats(onlyFeat).length > 0);
  for (const d of [...onlyCover, ...onlyFeat]) {
    for (const k of ['row', 'col', 'ox', 'oy', 'radius']) assert.ok(Number.isFinite(d[k]), `${k}`);
  }
});

test('normalizeBiomes clamps garbage densities', () => {
  const dens = (b) => worldConfig(world({ biomes: [biome(b)] })).biomes[0];
  const cases = [
    [{ feature_density: -1, cover_density: -1 }, 0, 0],
    [{ feature_density: NaN, cover_density: NaN }, 0.6, 0],
    [{ feature_density: 'x', cover_density: 'x' }, 0.6, 0],
    [{ feature_density: 9, cover_density: 9 }, 1, 3],
    [{ feature_density: null, cover_density: null }, 0.6, 0],
    [{}, 0.6, 0],
    [{ feature_density: 0.25, cover_density: 1.5 }, 0.25, 1.5],
  ];
  for (const [raw, f, c] of cases) {
    const b = dens(raw);
    assert.equal(b.featureDensity, f, JSON.stringify(raw));
    assert.equal(b.coverDensity, c, JSON.stringify(raw));
  }
});

test('deterministic; opts.cover=false equals the feature subset; cover emitted after features', () => {
  const w = world({ biomes: [biome({ cover_density: 2 })] });
  const a = gen(w).out, b = gen(w).out;
  assert.deepStrictEqual(a, b);
  const only = gen(w, DEFS, { cover: false }).out;
  assert.deepStrictEqual(only, feats(a));
  assert.ok(covers(a).length > 0);
  const firstCover = a.findIndex((d) => d.layer === 'cover');
  assert.ok(a.slice(firstCover).every((d) => d.layer === 'cover'));
});

test('a block_radius above half a tile is clamped to 50 and its circle stays in the tile', () => {
  const huge = [{ name: 'Tree', walkable: false, spawn_tiles: ['grass'], chance: 1, block_radius: 80 }];
  const { out } = gen(world({ biomes: [] }), huge);
  const f = feats(out).filter((d) => d.blocking);
  assert.ok(f.length > 20);
  for (const d of f) {
    assert.equal(d.radius, 50);
    assert.ok(d.ox - d.radius >= 0 && d.ox + d.radius <= 100, `ox ${d.ox}`);
    assert.ok(d.oy - d.radius >= 0 && d.oy + d.radius <= 100, `oy ${d.oy}`);
  }
});

test('block_radius 0 and null on a blocking type both mean the default radius', () => {
  for (const br of [0, null, undefined]) {
    const defs = [{ ...TREE, block_radius: br }];
    const { out } = gen(world({ biomes: [] }), defs);
    assert.ok(out.length > 0);
    for (const d of out) {
      assert.equal(d.blocking, true);
      assert.equal(d.radius, DEFAULT_BLOCK_RADIUS, `block_radius ${br}`);
    }
  }
});
