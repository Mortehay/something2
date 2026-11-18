// SOMET-776: monuments -- a big sprite over a multi-tile blocking footprint,
// delivered through the chunk decoration list.
const test = require('node:test');
const assert = require('node:assert');
const { generateRegion, generateChunkDecorations, worldConfig, placeMapCreatures } = require('../src/services/mapService');
const { assertNavigable, blockingDecorationCells } = require('../src/services/navigability');
const { generateStructureSites, validSites, isPoiRuin, monumentFront } = require('../src/services/structureSites');
const { ServerMap } = require('../src/authority/collision');
const { STRUCTURE_TYPES, MONUMENT_TYPES } = require('../seeds/data/structureTypes.js');

const tileTypes = {
  grass: { walkable: true }, highgrass: { walkable: true }, dirt: { walkable: true }, water: { walkable: false },
  map_wall: { walkable: false }, map_doorway: { walkable: true }, wooden_wall: { walkable: false },
  village_gate: { walkable: true }, cobblestone: { walkable: true },
  mossy_wall: { walkable: false }, rubble_floor: { walkable: true },
};
const MEADOW = { name: 'Meadow', terrain_tiles: ['grass', 'highgrass'], flora_types: ['bush', 'Tree'], path_tile: 'dirt' };
const DEFS = [
  { name: 'Tree', walkable: false, spawn_tiles: ['grass', 'highgrass'], chance: 1, deco_layer: 'main' },
  { name: 'bush', walkable: true, spawn_tiles: ['grass', 'highgrass'], chance: 1, deco_layer: 'ground' },
];
function world(over = {}) {
  return { seed: 4242, chunkSize: 32, width: 96, height: 96, tileTypes, biomes: [MEADOW], entry_spawn: { x: 4850, y: 4850 }, ...over };
}
const SPAWN = { row: 48, col: 48, what: 'entry spawn' };
// A 3x3 monument straddling the chunk seam at row/col 32 (chunkSize 32).
const STATUE = { kind: 'monument', type: 'collapsed_tower', sprite: 'collapsed_tower', minRow: 30, minCol: 31, width: 3, height: 3, source: 'auto' };
const footprint = (m) => { const out = []; for (let r = m.minRow; r < m.minRow + m.height; r++) for (let c = m.minCol; c < m.minCol + m.width; c++) out.push(`${r},${c}`); return out; };

function allEntries(w, defs) {
  const cfg = worldConfig(w);
  const N = cfg.chunkSize;
  const out = [];
  for (let cy = 0; cy * N < w.height; cy++) for (let cx = 0; cx * N < w.width; cx++) {
    const tiles = generateRegion(w, cy * N, cx * N, N, N);
    for (const d of generateChunkDecorations(w, cx, cy, tiles, defs)) out.push({ ...d, gRow: cy * N + d.row, gCol: cx * N + d.col, cx, cy });
  }
  return out;
}

test('a monument is one drawn anchor on its front cell plus hidden blockers, across a chunk seam, with no defs', () => {
  const entries = allEntries(world({ structures: [STATUE] }), []);
  const mine = entries.filter((e) => e.name === 'collapsed_tower');
  assert.deepEqual(mine.map((e) => `${e.gRow},${e.gCol}`).sort(), footprint(STATUE).sort());
  assert.ok(mine.every((e) => e.blocking === true));
  const anchors = mine.filter((e) => !e.hidden);
  assert.equal(anchors.length, 1, 'drawn exactly once');
  assert.equal(`${anchors[0].gRow},${anchors[0].gCol}`, '32,33', 'anchor is the front (max row, max col) cell');
  assert.deepEqual(anchors[0].monument, { w: 3, h: 3 });
  assert.equal(new Set(mine.map((e) => `${e.cx},${e.cy}`)).size, 4, 'the footprint spans four chunks');
});

test('no decoration of either layer lands on a footprint cell, and the rest of the layout does not move', () => {
  const without = allEntries(world(), DEFS);
  const withM = allEntries(world({ structures: [STATUE] }), DEFS);
  const fp = new Set(footprint(STATUE));
  const others = withM.filter((e) => e.name !== 'collapsed_tower');
  assert.ok(others.every((e) => !fp.has(`${e.gRow},${e.gCol}`)));
  const key = (e) => `${e.name}@${e.gRow},${e.gCol}`;
  assert.deepEqual(others.map(key).sort(), without.filter((e) => !fp.has(`${e.gRow},${e.gCol}`)).map(key).sort());
});

test('monument cells block in the TERRAIN pass of the seal check', () => {
  // A wall of three 3x3 monuments across a 9-wide map from edge to edge.
  const narrow = { seed: 1, chunkSize: 32, width: 11, height: 20, tileTypes, biomes: [MEADOW] };
  const wall = [1, 4, 7].map((c) => ({ ...STATUE, minRow: 9, minCol: c }));
  const req = [{ row: 3, col: 5, what: 'north' }, { row: 16, col: 5, what: 'south' }];
  assert.deepEqual(assertNavigable(narrow, req), []);
  const problems = assertNavigable({ ...narrow, structures: wall }, req);
  assert.ok(problems.some((p) => /^south at \(16,5\) is unreachable$/.test(p)), problems.join('\n'));
  // and the decoration overlay sees them too (authority parity source)
  const cells = blockingDecorationCells({ ...narrow, structures: wall }, []);
  for (const m of wall) for (const k of footprint(m)) assert.ok(cells.has(k));
});

test('authority collision blocks the WHOLE of every footprint tile with an empty decoration catalog', () => {
  const map = new ServerMap(world({ structures: [STATUE], decorationDefs: [] }));
  for (const k of footprint(STATUE)) {
    const [r, c] = k.split(',').map(Number);
    // centre and a corner: a monument is solid, not a tree's 20px trunk
    for (const [dx, dy] of [[50, 50], [3, 3], [97, 60]]) {
      assert.equal(map.isWalkable(c * 100 + dx, r * 100 + dy), false, `cell ${k} (+${dx},+${dy}) walkable on the server`);
    }
  }
  assert.equal(map.isWalkable(31 * 100 + 50, 29 * 100 + 50), true, 'the cell north of it is open');
  // every entry says solid, so the client builds the same set
  assert.ok(allEntries(world({ structures: [STATUE] }), []).every((e) => e.solid === true));
});

test('creatures are never placed on a footprint', () => {
  // A 12x12 map: a 5x5 monument fills a third of its 10x10 interior.
  const big = { ...STATUE, minRow: 3, minCol: 3, width: 5, height: 5 };
  const w = world({ width: 12, height: 12, structures: [big], entry_spawn: null, biomes: [{ ...MEADOW, creature_types: ['Slime'] }] });
  const placed = placeMapCreatures(w, 200, [{ name: 'Slime' }], 7);
  const fp = new Set(footprint(big));
  assert.ok(placed.length > 20, `placed ${placed.length}`);
  for (const p of placed) assert.ok(!fp.has(`${Math.floor(p.y / 100)},${Math.floor(p.x / 100)}`), 'creature on a monument');
});

test('the generator adds monuments after ruins without moving a ruin, in their biomes, deterministically', () => {
  const ruinsOnly = generateStructureSites(world(), { styles: STRUCTURE_TYPES, required: [SPAWN] });
  const both = generateStructureSites(world(), { styles: STRUCTURE_TYPES, monuments: MONUMENT_TYPES, required: [SPAWN] });
  assert.deepEqual(both.filter((s) => s.kind !== 'monument'), ruinsOnly);
  const mons = both.filter((s) => s.kind === 'monument');
  assert.ok(mons.length > 0, 'a 96x96 meadow gets a monument');
  for (const m of mons) {
    const cat = MONUMENT_TYPES.find((t) => t.name === m.type);
    assert.ok(cat && cat.biomes.includes('Meadow'));
    assert.equal(m.sprite, cat.sprite);
    assert.deepEqual([m.width, m.height], cat.size);
  }
  assert.deepEqual(generateStructureSites(world(), { styles: STRUCTURE_TYPES, monuments: MONUMENT_TYPES, required: [SPAWN] }), both);
});

test('re-running with everything kept changes nothing, and stored monuments validate', () => {
  const opts = { styles: STRUCTURE_TYPES, monuments: MONUMENT_TYPES, required: [SPAWN] };
  const first = generateStructureSites(world(), opts);
  assert.deepEqual(validSites(world(), first, opts), first);
  assert.deepEqual(generateStructureSites(world(), { ...opts, keep: first }), first);
  // a monument type missing from the catalog is not valid
  assert.deepEqual(validSites(world(), first, { ...opts, monuments: [] }), first.filter((s) => s.kind !== 'monument'));
});

test('existing ruins as keep: monuments are added, ruins kept', () => {
  const ruins = generateStructureSites(world(), { styles: STRUCTURE_TYPES, required: [SPAWN] });
  const next = generateStructureSites(world(), { styles: STRUCTURE_TYPES, monuments: MONUMENT_TYPES, required: [SPAWN], keep: ruins });
  assert.deepEqual(next.slice(0, ruins.length), ruins);
  assert.ok(next.length > ruins.length);
});

test('every monument front tile is reachable and decoration-free', () => {
  const w = world();
  const sites = generateStructureSites(w, { styles: STRUCTURE_TYPES, monuments: MONUMENT_TYPES, required: [SPAWN], decorationDefs: DEFS });
  const mons = sites.filter((s) => s.kind === 'monument');
  assert.ok(mons.length > 0);
  const fronts = mons.map((m) => ({ ...monumentFront(m), what: 'front' }));
  assert.deepEqual(assertNavigable({ ...w, structures: sites, noGeneratedRoads: true }, [SPAWN, ...fronts], { decorationDefs: DEFS }), []);
});

test('POI roll reads the monument catalog', () => {
  const m = { kind: 'monument', type: 'broken_statue', minRow: 10, minCol: 10, width: 2, height: 2 };
  assert.equal(isPoiRuin(1, { ...m, poi: true }, STRUCTURE_TYPES), true);
  const always = [{ ...MONUMENT_TYPES.find((t) => t.name === 'broken_statue'), poiChance: 1 }];
  assert.equal(isPoiRuin(1, m, STRUCTURE_TYPES, always), true);
  assert.equal(isPoiRuin(1, m, STRUCTURE_TYPES, []), false);
});

test('catalog: unique names, square footprints, sprite per type, biomes', () => {
  assert.equal(MONUMENT_TYPES.length, 5);
  assert.equal(new Set(MONUMENT_TYPES.map((m) => m.name)).size, 5);
  for (const m of MONUMENT_TYPES) {
    assert.equal(m.size[0], m.size[1], `${m.name} footprint is square`);
    assert.ok(m.size[0] >= 2 && m.size[0] <= 3);
    assert.ok(typeof m.sprite === 'string' && m.biomes.length > 0 && m.weight > 0);
  }
});
