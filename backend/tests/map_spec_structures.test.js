// SOMET-775: ruins and monuments authored in a map spec.
const test = require('node:test');
const assert = require('node:assert');
const { validateMapSpec } = require('../seeds/mapSpec.js');
const { resolveSpecStructures } = require('../src/services/structureSites');
const { STRUCTURE_TYPES, MONUMENT_TYPES } = require('../seeds/data/structureTypes.js');

const world = (over = {}) => ({
  key: 'a', name: 'zzStruct', grid: [0, 0], seed: 77, width: 48, height: 48, chunk_size: 64,
  biomes: [], allowed_creature_types: [], is_entry: true, entry_spawn: { x: 2450, y: 2450 }, ...over,
});
const spec = (w) => ({ name: 's', topology: 'spine', worlds: [w], links: [] });
const errs = (w) => validateMapSpec(spec(w)).filter((e) => /structure/.test(e));

test('a valid ruin and monument pass', () => {
  assert.deepEqual(errs(world({
    structures: [
      { type: 'overgrown_hut', min_row: 5, min_col: 5, size: [5, 4], poi: true },
      { type: 'broken_statue', min_row: 30, min_col: 30 },
    ],
    structures_auto: false,
  })), []);
});

test('every malformed entry is a validation error naming the world and entry', () => {
  const cases = [
    [{ type: 'castle', min_row: 5, min_col: 5 }, /unknown type "castle"/],
    [{ type: 'overgrown_hut', min_row: 5 }, /min_col must be an integer/],
    [{ type: 'overgrown_hut', min_row: 1, min_col: 5 }, /inside the map/],
    [{ type: 'overgrown_hut', min_row: 44, min_col: 5 }, /inside the map/],
    [{ type: 'overgrown_hut', min_row: 5, min_col: 5, size: [2, 9] }, /size/],
    [{ type: 'broken_statue', min_row: 5, min_col: 5, size: [3, 3] }, /monument .* size is fixed/],
    [{ type: 'overgrown_hut', min_row: 5, min_col: 5, poi: 'yes' }, /poi must be true or false/],
    [{ type: 'overgrown_hut', min_row: 5, min_col: 5, rotation: 90 }, /unknown key "rotation"/],
  ];
  for (const [entry, re] of cases) {
    const e = errs(world({ structures: [entry] }));
    assert.ok(e.some((m) => re.test(m) && /world "a" structure 0/.test(m)), `${JSON.stringify(entry)} -> ${JSON.stringify(e)}`);
  }
  assert.ok(errs(world({ structures: {} })).some((m) => /structures must be an array/.test(m)));
  assert.ok(errs(world({ structures_auto: 'no' })).some((m) => /structures_auto must be true or false/.test(m)));
});

test('a structure may not overlap another, a village, a pen, the chest, a waypoint, the boss or the entry spawn', () => {
  const base = { type: 'overgrown_hut', min_row: 10, min_col: 10, size: [4, 4] }; // rows/cols 10..13
  const cases = [
    [{ structures: [base, { type: 'broken_statue', min_row: 14, min_col: 12 }] }, /too close to structure 0/],
    [{ village: { key: 'v', min_row: 12, min_col: 12, width: 4, height: 3, gate_edge: 'S', spawn_x: 1350, spawn_y: 1350 } }, /village/],
    [{ chest: { x: 1150, y: 1150 } }, /chest/],
    [{ waypoints: [{ x: 1250, y: 1050, name: 'w' }] }, /waypoint/],
    [{ entry_spawn: { x: 1150, y: 1150 } }, /entry spawn/],
  ];
  for (const [over, re] of cases) {
    const w = world({ structures: [base], ...over });
    const e = errs(w);
    assert.ok(e.some((m) => re.test(m)), `${JSON.stringify(over)} -> ${JSON.stringify(e)}`);
  }
});

test('resolution: a spec ruin is a full stamp with seeded gaps, a monument carries its sprite; both source "spec"', () => {
  const w = world({ structures: [
    { type: 'burned_cabin', min_row: 5, min_col: 6, size: [5, 3], poi: false },
    { type: 'giant_skull', min_row: 20, min_col: 20 },
  ] });
  const [ruin, mon] = resolveSpecStructures(w, { styles: STRUCTURE_TYPES, monuments: MONUMENT_TYPES });
  const style = STRUCTURE_TYPES.find((s) => s.name === 'burned_cabin');
  assert.deepEqual({ ...ruin, gaps: undefined }, {
    type: 'burned_cabin', minRow: 5, minCol: 6, width: 5, height: 3,
    wallTile: style.wallTile, floorTile: style.floorTile, gaps: undefined, source: 'spec', poi: false,
  });
  assert.ok(ruin.gaps.length >= 2);
  assert.deepEqual(mon, { kind: 'monument', type: 'giant_skull', sprite: 'giant_skull', minRow: 20, minCol: 20, width: 3, height: 3, source: 'spec' });
  // deterministic, and a default size is the style's first
  assert.deepEqual(resolveSpecStructures(w, { styles: STRUCTURE_TYPES, monuments: MONUMENT_TYPES }), [ruin, mon]);
  const [d] = resolveSpecStructures(world({ structures: [{ type: 'burned_cabin', min_row: 5, min_col: 6 }] }), { styles: STRUCTURE_TYPES, monuments: MONUMENT_TYPES });
  assert.deepEqual([d.width, d.height], style.sizes[0]);
  assert.equal('poi' in d, false, 'no poi key means the seeded roll decides');
});

test('decoration placement keeps blockers off a site key tile (a spec site cannot dodge a tree)', () => {
  const { generateRegion, generateChunkDecorations } = require('../src/services/mapService');
  const tt = { grass: { walkable: true }, map_wall: { walkable: false }, map_doorway: { walkable: true }, rubble_floor: { walkable: true }, mossy_wall: { walkable: false } };
  const MEADOW = { name: 'Meadow', terrain_tiles: ['grass'], flora_types: ['Tree'] };
  const defs = [{ name: 'Tree', walkable: false, spawn_tiles: ['grass'], chance: 1, deco_layer: 'main' }];
  const w = (structures) => ({ seed: 9, chunkSize: 64, width: 64, height: 64, tileTypes: tt, biomes: [MEADOW], structures });
  const trees = (world) => generateChunkDecorations(world, 0, 0, generateRegion(world, 0, 0, 64, 64), defs)
    .filter((d) => d.name === 'Tree' && d.blocking).map((d) => `${d.row},${d.col}`);
  const bare = trees(w([]));
  const t = bare.map((k) => k.split(',').map(Number)).find(([r, c]) => r > 10 && c > 10 && r < 50 && c < 50);
  assert.ok(t, 'the fixture grows trees');
  const mon = { kind: 'monument', type: 'giant_skull', sprite: 'giant_skull', minRow: t[0] - 3, minCol: t[1] - 1, width: 3, height: 3, source: 'spec' };
  const ruin = { type: 'overgrown_hut', minRow: t[0] - 1, minCol: t[1] - 1, width: 4, height: 4, wallTile: 'mossy_wall', floorTile: 'rubble_floor', gaps: [], source: 'spec' };
  assert.ok(!trees(w([mon])).includes(`${t[0]},${t[1]}`), 'tree on the monument front');
  // a ruin interior tile is rubble_floor, which no tree spawns on anyway; the
  // key-tile rule must not move any OTHER tree
  const withRuin = trees(w([ruin]));
  const inRuin = (k) => { const [r, c] = k.split(',').map(Number); return r >= ruin.minRow && r < ruin.minRow + 4 && c >= ruin.minCol && c < ruin.minCol + 4; };
  assert.deepEqual(withRuin.filter((k) => !inRuin(k)), bare.filter((k) => !inRuin(k)));
});
