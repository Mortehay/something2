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

// SOMET-339. A village's footprint was already spared from blocking
// decorations, but the ground OUTSIDE its gate was not -- so the clump field
// could wall a village in. That was invisible until SOMET-335 moved the entry
// spawn inside the village: before it, a player spawned outside and a sealed
// gate only meant "cannot get in".
//
// Village rows 2..4, cols 2..4 with an E gate, so villageGateCell is
// (midRow 3, cMax 4) and the corridor runs east from col 5. Seed 9 is chosen
// deliberately: WITHOUT the corridor exclusion it puts blockers on the gate
// line itself at cols 6,7,8,9, i.e. this test genuinely fails against the
// pre-fix generator rather than passing vacuously.
function gatedWorld(overrides = {}) {
  return world({
    seed: 9, chunkSize: 16, width: 16, height: 16,
    villages: [{
      minRow: 2, minCol: 2, width: 3, height: 3,
      gateEdge: 'E', wallTile: 'rocks', gateTile: 'grass',
    }],
    ...overrides,
  });
}
const SOLID = [{ name: 'Tree', walkable: false, spawn_tiles: ['grass', 'rocks'], chance: 1 }];

test('the corridor outside a village gate gets no BLOCKING decoration', () => {
  const w = gatedWorld();
  const decos = generateChunkDecorations(w, 0, 0, generateChunk(w, 0, 0), SOLID);
  const blocked = new Set(decos.filter((d) => d.blocking).map((d) => `${d.row},${d.col}`));
  // Hand-typed corridor: gate line row 3, one tile either side (rows 2..4),
  // running 6 tiles out (cols 5..10). Literals, not read back from the
  // constants under test -- deriving them would pass for any corridor at all.
  for (let c = 5; c <= 10; c++) {
    for (let r = 2; r <= 4; r++) {
      assert.ok(!blocked.has(`${r},${c}`), `blocking decoration seals the gate corridor at (${r},${c})`);
    }
  }
});

test('the gate corridor exclusion is bounded, not a blanket clearing', () => {
  // If the exclusion were too greedy it would strip blockers from the whole
  // map and this feature would quietly become "villages have no trees near
  // them anywhere", which is a content change nobody asked for.
  const w = gatedWorld();
  const decos = generateChunkDecorations(w, 0, 0, generateChunk(w, 0, 0), SOLID);
  const beyond = decos.filter((d) => d.blocking && d.col > 10);
  assert.ok(beyond.length > 0, 'blocking decorations must still place beyond the corridor');
});

test('a village with no gate edge still spares its own footprint', () => {
  // Defensive: gateEdge is authored data and can be absent. The corridor code
  // must not throw or accidentally clear the whole map when it is missing.
  const w = gatedWorld({
    villages: [{ minRow: 2, minCol: 2, width: 3, height: 3, wallTile: 'rocks', gateTile: 'grass' }],
  });
  const decos = generateChunkDecorations(w, 0, 0, generateChunk(w, 0, 0), SOLID);
  for (const d of decos) {
    const inside = d.row >= 2 && d.row <= 4 && d.col >= 2 && d.col <= 4;
    assert.ok(!(d.blocking && inside), `blocking decoration inside the village at (${d.row},${d.col})`);
  }
  assert.ok(decos.some((d) => d.blocking), 'blockers should still place elsewhere');
});
