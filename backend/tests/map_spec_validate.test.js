const test = require('node:test');
const assert = require('node:assert');
const { validateMapSpec, EDGE_DELTA } = require('../seeds/mapSpec.js');

// A minimal two-world spec that is VALID: `b` sits one cell east of `a`,
// and the link from a to b is edge E. Every negative case below is this
// object with exactly one thing broken, so a failure names one cause.
const valid = () => ({
  name: 'fixture',
  topology: 'spine',
  worlds: [
    { key: 'a', name: 'Alpha', grid: [0, 0], seed: 1, width: 64, height: 64,
      chunk_size: 64, biomes: ['Meadow'], biome_cell: 32, creature_count: 1,
      allowed_creature_types: ['Slime'], is_entry: true,
      entry_spawn: { x: 32, y: 32 } },
    { key: 'b', name: 'Beta', grid: [1, 0], seed: 2, width: 64, height: 64,
      chunk_size: 64, biomes: ['Meadow'], biome_cell: 32, creature_count: 3,
      allowed_creature_types: ['Wolf'], is_entry: false },
  ],
  links: [{ from: 'a', edge: 'E', to: 'b' }],
});

const errorsFor = (mutate) => {
  const spec = valid();
  mutate(spec);
  return validateMapSpec(spec);
};

test('N is -y and S is +y, matching edgeOfDoorwayTile', () => {
  // mapService.js:724 defines N as gRow === 0, the TOP row. If this ever
  // flips, every generated map arrives through the wrong doorway.
  assert.deepEqual(EDGE_DELTA.N, [0, -1]);
  assert.deepEqual(EDGE_DELTA.S, [0, 1]);
  assert.deepEqual(EDGE_DELTA.E, [1, 0]);
  assert.deepEqual(EDGE_DELTA.W, [-1, 0]);
});

test('accepts a well-formed spec', () => {
  assert.deepEqual(validateMapSpec(valid()), []);
});

// The brief's "contradicts the grid" test below only proves SOME mismatch is
// detected when edge 'N' is substituted for the correct 'E' -- it still
// passes even if EDGE_DELTA.N's sign is flipped, because [0,1] and [0,-1]
// are equally wrong for an east neighbour. Mutating EDGE_DELTA.N to [0, 1]
// during Step 5 confirmed this: only the literal axis-value test failed.
// This test is the actual regression guard for the N/S sign convention: a
// spec that uses all four edges, each genuinely correct for its grid delta,
// must validate cleanly. Flip N's sign and this fails because the "north"
// link's target no longer matches the (broken) computed cell.
test('accepts a spec using all four edges, each matching its true grid delta', () => {
  const base = (key, name, grid) => ({
    key, name, grid, seed: 1, width: 64, height: 64, chunk_size: 64,
    biomes: ['Meadow'], biome_cell: 32, creature_count: 1,
    allowed_creature_types: ['Slime'], is_entry: key === 'hub',
  });
  const spec = {
    name: 'compass', topology: 'spine',
    worlds: [
      base('hub', 'Hub', [0, 0]),
      base('north', 'North', [0, -1]),
      base('south', 'South', [0, 1]),
      base('east', 'East', [1, 0]),
      base('west', 'West', [-1, 0]),
    ],
    links: [
      { from: 'hub', edge: 'N', to: 'north' },
      { from: 'hub', edge: 'S', to: 'south' },
      { from: 'hub', edge: 'E', to: 'east' },
      { from: 'hub', edge: 'W', to: 'west' },
    ],
  };
  assert.deepEqual(validateMapSpec(spec), []);
});

test('rejects an edge that contradicts the grid', () => {
  // b is EAST of a, so claiming the link is N must fail.
  const errs = errorsFor((s) => { s.links[0].edge = 'N'; });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /edge N.*grid/i);
});

test('rejects a link between non-adjacent cells', () => {
  const errs = errorsFor((s) => { s.worlds[1].grid = [5, 0]; });
  assert.ok(errs.some((e) => /adjacent/i.test(e)), errs.join('; '));
});

test('rejects two worlds in the same grid cell', () => {
  const errs = errorsFor((s) => { s.worlds[1].grid = [0, 0]; });
  assert.ok(errs.some((e) => /same grid cell|occupied/i.test(e)), errs.join('; '));
});

test('rejects two links leaving one world by the same edge', () => {
  const errs = errorsFor((s) => {
    s.worlds.push({ key: 'c', name: 'Gamma', grid: [0, 1], seed: 3, width: 64, height: 64,
      chunk_size: 64, biomes: ['Meadow'], biome_cell: 32, creature_count: 1,
      allowed_creature_types: ['Slime'], is_entry: false });
    s.links.push({ from: 'a', edge: 'E', to: 'c' });   // E is already taken
  });
  assert.ok(errs.some((e) => /already has a link on edge E|duplicate edge/i.test(e)), errs.join('; '));
});

// The brief's "same edge twice" test above pushes a *second* link (a->c)
// that is simultaneously a duplicate edge AND a grid contradiction (c sits
// south of a, not east), so a validator that only checked grid contradiction
// would pass that test too. This variant repeats the SAME link (a->b, edge
// E, to a genuinely-east neighbour) so the grid check is satisfied both
// times and only the duplicate-edge rule can be responsible for the error.
test('rejects the same edge declared twice even when both point at the correctly-placed neighbor', () => {
  const spec = valid();
  spec.links.push({ from: 'a', edge: 'E', to: 'b' });
  const errs = validateMapSpec(spec);
  assert.equal(errs.length, 1, errs.join('; '));
  assert.match(errs[0], /already has a link on edge E/i);
});

test('rejects a world whose grid is not two integers', () => {
  const errs = errorsFor((s) => { s.worlds[1].grid = [0.5, 0]; });
  assert.ok(errs.some((e) => /grid must be two integers/i.test(e)), errs.join('; '));
});

test('rejects a link with an edge letter outside N/E/S/W', () => {
  const errs = errorsFor((s) => { s.links[0].edge = 'NE'; });
  assert.ok(errs.some((e) => /invalid edge/i.test(e)), errs.join('; '));
});

test('rejects a five-spoke hub, because UNIQUE(from_world_id, edge) allows four', () => {
  const spec = valid();
  spec.worlds = [spec.worlds[0]];
  spec.links = [];
  const cells = [[1, 0], [-1, 0], [0, -1], [0, 1], [2, 0]];
  const edges = ['E', 'W', 'N', 'S', 'E'];
  cells.forEach(([x, y], i) => {
    spec.worlds.push({ key: `s${i}`, name: `Spoke ${i}`, grid: [x, y], seed: 10 + i,
      width: 64, height: 64, chunk_size: 64, biomes: ['Meadow'], biome_cell: 32,
      creature_count: 1, allowed_creature_types: ['Slime'], is_entry: false });
    spec.links.push({ from: 'a', edge: edges[i], to: `s${i}` });
  });
  assert.ok(validateMapSpec(spec).length > 0, 'a 5th spoke must be rejected');
});

test('rejects zero entries and more than one entry', () => {
  assert.ok(errorsFor((s) => { s.worlds[0].is_entry = false; })
    .some((e) => /exactly one .*is_entry/i.test(e)));
  assert.ok(errorsFor((s) => { s.worlds[1].is_entry = true; })
    .some((e) => /exactly one .*is_entry/i.test(e)));
});

test('rejects duplicate keys and duplicate names', () => {
  assert.ok(errorsFor((s) => { s.worlds[1].key = 'a'; }).some((e) => /duplicate key/i.test(e)));
  assert.ok(errorsFor((s) => { s.worlds[1].name = 'Alpha'; }).some((e) => /duplicate name/i.test(e)));
});

test('rejects a link referencing an unknown key', () => {
  assert.ok(errorsFor((s) => { s.links[0].to = 'nope'; }).some((e) => /unknown/i.test(e)));
});

test('rejects a world unreachable from the entry', () => {
  const errs = errorsFor((s) => { s.links = []; });
  assert.ok(errs.some((e) => /unreachable|not reachable/i.test(e)), errs.join('; '));
});

test('rejects a village outside the size limits the API enforces', () => {
  // index.js validateVillageBody: width 3-8, height 3-6.
  const errs = errorsFor((s) => {
    s.worlds[0].village = { min_row: 4, min_col: 4, width: 20, height: 20,
      gate_edge: 'S', spawn_x: 500, spawn_y: 600 };
  });
  assert.ok(errs.some((e) => /width must be between 3 and 8/i.test(e)), errs.join('; '));
  // The brief's test only exercised width; height=20 is also out of bounds
  // in the same fixture but nothing asserted it, so the height branch could
  // have been silently broken (or missing) and this test would still pass.
  assert.ok(errs.some((e) => /height must be between 3 and 6/i.test(e)), errs.join('; '));
});

test('rejects a village gate_edge outside N/E/S/W', () => {
  // Nothing in the brief's suite ever sets an invalid gate_edge -- this
  // fixture uses valid width/height so gate_edge is the only broken field.
  const errs = errorsFor((s) => {
    s.worlds[0].village = { min_row: 4, min_col: 4, width: 5, height: 4,
      gate_edge: 'UP', spawn_x: 500, spawn_y: 600 };
  });
  assert.equal(errs.length, 1, errs.join('; '));
  assert.match(errs[0], /gate_edge must be one of N,E,S,W/i);
});

test('cross-checks catalog names only when catalogs are supplied', () => {
  const spec = valid();
  assert.deepEqual(validateMapSpec(spec), [], 'no catalogs supplied -> no catalog errors');
  const errs = validateMapSpec(spec, {
    biomeNames: new Set(['Mire']), creatureTypeNames: new Set(['Slime', 'Wolf']),
  });
  assert.ok(errs.some((e) => /Meadow/.test(e)), errs.join('; '));
});

// The test above supplies creatureTypeNames = {'Slime','Wolf'}, which are
// exactly the types the fixture uses -- so the creature-type branch never
// actually runs against a mismatch. This closes that gap directly.
test('cross-checks creature type names when the catalog is supplied', () => {
  const errs = validateMapSpec(valid(), {
    biomeNames: new Set(['Meadow']), creatureTypeNames: new Set(['Slime']),
  });
  assert.ok(errs.some((e) => /unknown creature type "Wolf"/i.test(e)), errs.join('; '));
});
