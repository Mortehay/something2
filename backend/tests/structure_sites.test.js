// SOMET-773: the pure ruin-site generator.
const test = require('node:test');
const assert = require('node:assert');
const { generateStructureSites, STRUCTURE_CAP } = require('../src/services/structureSites');
const { generateRegion } = require('../src/services/mapService');
const { assertNavigable } = require('../src/services/navigability');
const { STRUCTURE_TYPES } = require('../seeds/data/structureTypes.js');

const tileTypes = {
  grass: { walkable: true }, highgrass: { walkable: true }, dirt: { walkable: true }, water: { walkable: false },
  map_wall: { walkable: false }, map_doorway: { walkable: true }, wooden_wall: { walkable: false },
  village_gate: { walkable: true }, cobblestone: { walkable: true },
  mossy_wall: { walkable: false }, rubble_floor: { walkable: true },
};
const MEADOW = { name: 'Meadow', terrain_tiles: ['grass', 'highgrass', 'water'], flora_types: [], path_tile: 'dirt' };
function world(over = {}) {
  return { seed: 4242, chunkSize: 32, width: 96, height: 96, tileTypes, biomes: [MEADOW], entry_spawn: { x: 4850, y: 4850 }, ...over };
}
const SPAWN = { row: 48, col: 48, what: 'entry spawn' };
const cheb = (a, b) => Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));
const cells = (s) => { const out = []; for (let r = s.minRow; r < s.minRow + s.height; r++) for (let c = s.minCol; c < s.minCol + s.width; c++) out.push({ row: r, col: c }); return out; };

test('generation is deterministic and capped', () => {
  const a = generateStructureSites(world(), { styles: STRUCTURE_TYPES, required: [SPAWN] });
  const b = generateStructureSites(world(), { styles: STRUCTURE_TYPES, required: [SPAWN] });
  assert.deepEqual(a, b);
  assert.ok(a.length > 0, 'a 96x96 meadow gets ruins');
  assert.ok(a.length <= STRUCTURE_CAP);
  for (const s of a) assert.equal(s.type, 'overgrown_hut');
});

test('a footprint stays on walkable terrain, off roads, away from villages, required and avoided points', () => {
  const village = { id: 'v', min_row: 20, min_col: 20, width: 5, height: 4, gate_edge: 'S', spawn_x: 2250, spawn_y: 2450 };
  const avoid = [{ row: 70, col: 70, radius: 2 }];
  const w = world({ villages: [village] });
  const sites = generateStructureSites(w, { styles: STRUCTURE_TYPES, required: [SPAWN], avoid });
  assert.ok(sites.length > 0);
  const bare = generateRegion({ ...w, structures: [] }, 0, 0, 96, 96);
  for (const s of sites) {
    for (const cell of cells(s)) {
      assert.notEqual(tileTypes[bare[cell.row][cell.col]].walkable, false, `${s.type} on unwalkable ${cell.row},${cell.col}`);
      assert.notEqual(bare[cell.row][cell.col], 'dirt', 'on a road/path');
      assert.ok(cheb(cell, SPAWN) > 4, 'too close to the spawn');
      assert.ok(cheb(cell, avoid[0]) > 2, 'inside an avoid radius');
      const inVillageZone = cell.row >= 16 && cell.row <= 27 && cell.col >= 16 && cell.col <= 28;
      assert.ok(!inVillageZone, `inside the village clearance at ${cell.row},${cell.col}`);
      assert.ok(cell.row >= 2 && cell.col >= 2 && cell.row <= 93 && cell.col <= 93, 'too near the map edge');
    }
  }
});

test('sites never overlap, and keep at least two tiles apart', () => {
  const sites = generateStructureSites(world(), { styles: STRUCTURE_TYPES, required: [SPAWN] });
  for (let i = 0; i < sites.length; i++) for (let j = i + 1; j < sites.length; j++) {
    for (const a of cells(sites[i])) for (const b of cells(sites[j])) assert.ok(cheb(a, b) > 2, 'sites too close');
  }
});

test('every ruin is half destroyed: at least two gaps, on at least two sides', () => {
  for (const s of generateStructureSites(world(), { styles: STRUCTURE_TYPES, required: [SPAWN] })) {
    assert.ok(s.gaps.length >= 2, `${s.type} has ${s.gaps.length} gaps`);
    const side = ([r, c]) => (r === s.minRow ? 'N' : r === s.minRow + s.height - 1 ? 'S' : c === s.minCol ? 'W' : 'E');
    assert.ok(new Set(s.gaps.map(side)).size >= 2, 'gaps on one side only');
  }
});

test('across many seeds ruins never add a navigability problem', () => {
  let withRuins = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const w = world({ seed });
    const sites = generateStructureSites(w, { styles: STRUCTURE_TYPES, required: [SPAWN] });
    const bare = assertNavigable({ ...w, structures: [], noGeneratedRoads: true }, [SPAWN]);
    // A world already failing its own check gets no ruins at all: every
    // candidate is judged against the whole world, and nothing can pass.
    if (bare.length) { assert.deepEqual(sites, [], `seed ${seed} is already sealed`); continue; }
    withRuins += sites.length > 0 ? 1 : 0;
    const interiors = sites.map((s) => ({ row: s.minRow + 1, col: s.minCol + 1, what: s.type }));
    assert.deepEqual(assertNavigable({ ...w, structures: sites, noGeneratedRoads: true }, [SPAWN, ...interiors]), [], `seed ${seed}`);
  }
  assert.ok(withRuins >= 6, `only ${withRuins} of 12 seeds got ruins`);
});

test('a biome with no style gets no ruins', () => {
  const ABYSS = { ...MEADOW, name: 'Abyssal Rift' };
  assert.deepEqual(generateStructureSites(world({ biomes: [ABYSS] }), { styles: STRUCTURE_TYPES, required: [SPAWN] }), []);
});

test('kept sites come back unchanged and new ones keep clear of them', () => {
  const first = generateStructureSites(world(), { styles: STRUCTURE_TYPES, required: [SPAWN] });
  const keep = first.slice(0, 2);
  const again = generateStructureSites(world({ seed: 99 }), { styles: STRUCTURE_TYPES, required: [SPAWN], keep });
  assert.deepEqual(again.slice(0, 2), keep);
  for (const s of again.slice(2)) for (const k of keep) for (const a of cells(s)) for (const b of cells(k)) assert.ok(cheb(a, b) > 2);
});

// Review I2: re-validating stored ruins applies the SAME rules as placing them.
test('validSites drops a stored ruin that a new village, road, required point or biome change now conflicts with', () => {
  const { validSites } = require('../src/services/structureSites');
  const w = world();
  const sites = generateStructureSites(w, { styles: STRUCTURE_TYPES, required: [SPAWN] });
  assert.ok(sites.length >= 3);
  const opts = { styles: STRUCTURE_TYPES, required: [SPAWN] };
  assert.deepEqual(validSites(w, sites, opts), sites, 'nothing changed: all kept');
  const [a, b, c] = sites;
  // a village dropped right on top of the first ruin
  const village = { id: 'v', min_row: a.minRow, min_col: a.minCol, width: 5, height: 4, gate_edge: 'S' };
  assert.ok(!validSites({ ...w, villages: [village] }, sites, opts).includes(a), 'village over a ruin');
  // a required point (a new portal arrival) next to the second ruin
  assert.ok(!validSites(w, sites, { ...opts, required: [SPAWN, { row: b.minRow - 2, col: b.minCol, what: 'portal' }] }).includes(b), 'required point next to a ruin');
  // an authored road through the third ruin
  const road = [[c.minRow + 1, c.minCol - 3], [c.minRow + 1, c.minCol + c.width + 3]];
  assert.ok(!validSites({ ...w, authoredRoads: [road] }, sites, opts).includes(c), 'road through a ruin');
  // the biome changed under all of them
  const ABYSS = { ...MEADOW, name: 'Abyssal Rift' };
  assert.deepEqual(validSites({ ...w, biomes: [ABYSS] }, sites, opts), [], 'biome lost its style');
});
