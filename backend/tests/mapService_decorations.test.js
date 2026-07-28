const test = require('node:test');
const assert = require('node:assert');
const { generateChunk, generateChunkDecorations } = require('../src/services/mapService');

// A small bounded world with a couple of terrains and no paths/villages.
function world(overrides = {}) {
  return {
    seed: 12345, chunkSize: 8, width: 8, height: 8,
    tileTypes: { grass: { walkable: true, speed: 1 }, rocks: { walkable: true, speed: 1 } },
    ...overrides,
  };
}
const DEFS = [
  { name: 'Tree', walkable: false, spawn_tiles: ['grass'], chance: 0.5 },
  { name: 'Stone', walkable: false, spawn_tiles: ['rocks'], chance: 0.5 },
];

test('placement is deterministic for a given seed', () => {
  const w = world();
  const tiles = generateChunk(w, 0, 0);
  const a = generateChunkDecorations(w, 0, 0, tiles, DEFS);
  const b = generateChunkDecorations(w, 0, 0, tiles, DEFS);
  assert.deepEqual(a, b);
});

test('a different seed changes placement', () => {
  const w1 = world({ seed: 1 }), w2 = world({ seed: 2 });
  const d1 = generateChunkDecorations(w1, 0, 0, generateChunk(w1, 0, 0), DEFS);
  const d2 = generateChunkDecorations(w2, 0, 0, generateChunk(w2, 0, 0), DEFS);
  assert.notDeepEqual(d1, d2);
});

test('a decoration only lands on a tile in its spawn_tiles', () => {
  const w = world();
  const tiles = generateChunk(w, 0, 0);
  for (const d of generateChunkDecorations(w, 0, 0, tiles, DEFS)) {
    const def = DEFS.find((x) => x.name === d.name);
    assert.ok(def.spawn_tiles.includes(tiles[d.row][d.col]), `${d.name} on ${tiles[d.row][d.col]}`);
    assert.equal(d.blocking, def.walkable === false);
  }
});

test('empty defs yields no decorations', () => {
  const w = world();
  assert.deepEqual(generateChunkDecorations(w, 0, 0, generateChunk(w, 0, 0), []), []);
});

test('the entry-spawn tile and its clear radius get no BLOCKING decoration', () => {
  // Spawn at world px (250,250) -> tile (2,2). Dense chance so tiles would fill.
  const w = world({ entry_spawn: { x: 250, y: 250 } });
  const dense = [{ name: 'Tree', walkable: false, spawn_tiles: ['grass', 'rocks'], chance: 1 }];
  const decos = generateChunkDecorations(w, 0, 0, generateChunk(w, 0, 0), dense);
  for (const d of decos) {
    const cheb = Math.max(Math.abs(d.row - 2), Math.abs(d.col - 2));
    assert.ok(!(d.blocking && cheb <= 1), `blocking deco too close to spawn at (${d.row},${d.col})`);
  }
});

test('weighted selection lets multiple types share a terrain (no first-match shadowing)', () => {
  // Two types on the SAME terrain — both must appear across a chunk. The old
  // break-on-first-match placed only the lowest-id one; weighted pick surfaces both.
  const w = world({ seed: 7, chunkSize: 24, width: 24, height: 24 });
  const defs = [
    { name: 'Tree', walkable: false, spawn_tiles: ['grass'], chance: 0.5 },
    { name: 'Bush', walkable: true, spawn_tiles: ['grass'], chance: 0.5 },
  ];
  const decos = generateChunkDecorations(w, 0, 0, generateChunk(w, 0, 0), defs);
  const names = new Set(decos.map((d) => d.name));
  assert.ok(names.has('Tree') && names.has('Bush'), `both types should place, saw ${[...names]}`);
});

test('density is bounded — a chunk is nowhere near fully covered', () => {
  // The density + fill gates keep coverage well below "every eligible tile"
  // (the old chance*GAIN saturation filled ~85%).
  const w = world({ seed: 3, chunkSize: 24, width: 24, height: 24 });
  const defs = [{ name: 'Tree', walkable: false, spawn_tiles: ['grass', 'rocks'], chance: 1 }];
  const decos = generateChunkDecorations(w, 0, 0, generateChunk(w, 0, 0), defs);
  const coverage = decos.length / (24 * 24);
  assert.ok(decos.length > 0, 'some decorations should place');
  assert.ok(coverage < 0.5, `coverage ${(coverage * 100).toFixed(0)}% should be well under 50%`);
});
