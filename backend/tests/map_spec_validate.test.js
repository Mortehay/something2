const test = require('node:test');
const assert = require('node:assert');
const { validateMapSpec, EDGE_DELTA } = require('../seeds/mapSpec.js');
const { edgeOfDoorwayTile } = require('../src/services/mapService.js');

// A minimal two-world spec that is VALID: `b` sits one cell east of `a`,
// and the link from a to b is edge E. Every negative case below is this
// object with exactly one thing broken, so a failure names one cause.
const valid = () => ({
  name: 'fixture',
  topology: 'spine',
  worlds: [
    { key: 'a', name: 'Alpha', grid: [0, 0], seed: 1, width: 64, height: 64,
      chunk_size: 64, biomes: ['Meadow'], biome_cell: 32,
      allowed_creature_types: ['Slime'], is_entry: true,
      entry_spawn: { x: 32, y: 32 } },
    { key: 'b', name: 'Beta', grid: [1, 0], seed: 2, width: 64, height: 64,
      chunk_size: 64, biomes: ['Meadow'], biome_cell: 32,
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
  // Both assertions above encode the convention in the test itself -- they
  // never actually consult mapService.js's real behavior, so a change to
  // edgeOfDoorwayTile (e.g. flipping N to mean the bottom row) would leave
  // this suite green while every seeded doorway led the wrong way. Tie
  // EDGE_DELTA to the real source: row 0 of a doorway tile is documented as
  // north, so it must match EDGE_DELTA.N's sign.
  assert.equal(edgeOfDoorwayTile(0, 5, 64, 64), 'N');
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
    biomes: ['Meadow'], biome_cell: 32,
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
      chunk_size: 64, biomes: ['Meadow'], biome_cell: 32,
      allowed_creature_types: ['Slime'], is_entry: false });
    s.links.push({ from: 'a', edge: 'E', to: 'c' });   // E is already taken
  });
  assert.ok(errs.some((e) => /already has a link on edge E|duplicate edge/i.test(e)), errs.join('; '));
});

// The brief's "same edge twice" test above pushes a *second* link (a->c)
// whose target cell [0,1] is south of a, not east -- so that fixture has TWO
// simultaneous defects: a duplicate edge AND a grid contradiction. Disabling
// the duplicate-edge guard alone still fails that test (verified by
// mutation), because its regex happens to only match the duplicate message
// -- but the fixture can never assert an exact error count, since both
// checks always fire together there. This variant repeats the literal same
// link (a->b, edge E, to the genuinely-east neighbor) so the grid check
// passes cleanly and only the duplicate-edge rule can produce an error,
// which lets this test assert `errs.length === 1` -- something the brief's
// fixture structurally cannot do.
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

// validateMapSpec never checked world-level width/height at all: they are
// nullable columns and seed-map.js passes w.width/w.height straight into the
// INSERT with no `?? ` fallback (unlike chunk_size right next to it), so an
// omitted width/height used to pass this validator cleanly and
// write NULL at seed time -- producing a world the World Map tab reports as
// "not linkable" with no validator error to explain why. These three cover
// the gap: missing width, missing height, non-integer width.
test('rejects a world missing width', () => {
  const errs = errorsFor((s) => { delete s.worlds[0].width; });
  assert.ok(errs.some((e) => /world "a" width must be an integer/i.test(e)), errs.join('; '));
});

test('rejects a world missing height', () => {
  const errs = errorsFor((s) => { delete s.worlds[0].height; });
  assert.ok(errs.some((e) => /world "a" height must be an integer/i.test(e)), errs.join('; '));
});

test('rejects a non-integer width', () => {
  const errs = errorsFor((s) => { s.worlds[0].width = 64.5; });
  assert.ok(errs.some((e) => /world "a" width must be an integer/i.test(e)), errs.join('; '));
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
      allowed_creature_types: ['Slime'], is_entry: false });
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
  // Only the `to` side was covered above; replacing the `!from` guard with a
  // silent `continue` (dropping the link instead of reporting it) left the
  // suite green until this was added -- a typo'd `from` would otherwise
  // vanish the link from the seeded map with no error at all.
  assert.ok(errorsFor((s) => { s.links[0].from = 'nope'; }).some((e) => /unknown/i.test(e)));
});

test('rejects a world unreachable from the entry', () => {
  const errs = errorsFor((s) => { s.links = []; });
  assert.ok(errs.some((e) => /unreachable|not reachable/i.test(e)), errs.join('; '));
});

// Every link fixture above declares `from` as the entry side, so reachability
// BFS starting at the entry always walks the SAME direction the link was
// authored in. setLink writes both DB rows (from->to and its mirror), and
// the validator's adjacency map pushes both directions to model that -- but
// nothing pinned that down. Deleting the second `adjacency.get(l.to).push`
// call left the suite green (verified by mutation) because it only matters
// when a link is declared from the non-entry side, which no other test does.
test('reachability is undirected: a link declared from the non-entry side still connects it', () => {
  const spec = valid();
  spec.links = [{ from: 'b', edge: 'W', to: 'a' }]; // b is non-entry; a is entry
  assert.deepEqual(validateMapSpec(spec), []);
});

// The world loop reports a malformed grid and `continue`s past that world's
// OWN checks, but the link loop still dereferences from.grid[0]/to.grid[0]
// for any link touching it -- these three shapes throw instead of returning
// errors unless guarded (verified by mutation: reverting hasValidGrid's link-
// loop guard reproduces the crash for each). grid: [0.5, 0] in the "not two
// integers" test above is the one malformed shape that happens not to crash
// (it's a real 2-element array), so that test alone gave illusory coverage.
test('does not throw when a linked world is missing its grid property', () => {
  const spec = valid();
  delete spec.worlds[0].grid; // 'a' is the `from` side of links[0]
  let errs;
  assert.doesNotThrow(() => { errs = validateMapSpec(spec); });
  assert.ok(errs.some((e) => /world "a" grid must be two integers/i.test(e)), errs.join('; '));
});

test('does not throw when a linked world grid is null', () => {
  const spec = valid();
  spec.worlds[1].grid = null; // 'b' is the `to` side of links[0]
  let errs;
  assert.doesNotThrow(() => { errs = validateMapSpec(spec); });
  assert.ok(errs.some((e) => /world "b" grid must be two integers/i.test(e)), errs.join('; '));
});

test('does not throw when a linked world grid is not an array', () => {
  const spec = valid();
  spec.worlds[0].grid = '0,0';
  let errs;
  assert.doesNotThrow(() => { errs = validateMapSpec(spec); });
  assert.ok(errs.some((e) => /world "a" grid must be two integers/i.test(e)), errs.join('; '));
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

test('level_band must be a two-element array of integers', () => {
  const errs = errorsFor((s) => { s.worlds[0].level_band = [3]; });
  assert.ok(errs.some((e) => /level_band/i.test(e)), errs.join('; '));
});

test('level_band rejects an inverted band', () => {
  // The database CHECK would also catch this, but only after clear-maps has
  // already destroyed every world -- reseed-map runs the clear first. Failing
  // in the validator means the spec is rejected before anything is deleted.
  const errs = errorsFor((s) => { s.worlds[0].level_band = [9, 3]; });
  assert.ok(errs.some((e) => /level_band/i.test(e)), errs.join('; '));
});

test('level_band rejects a minimum below 1', () => {
  const errs = errorsFor((s) => { s.worlds[0].level_band = [0, 4]; });
  assert.ok(errs.some((e) => /level_band/i.test(e)), errs.join('; '));
});

test('level_band accepts a valid band and a fixed band', () => {
  assert.deepEqual(errorsFor((s) => { s.worlds[0].level_band = [2, 6]; }), []);
  assert.deepEqual(errorsFor((s) => { s.worlds[0].level_band = [4, 4]; }), []);
});

test('level_band is optional', () => {
  assert.deepEqual(validateMapSpec(valid()), []);
});

test('density accepts every tier name', () => {
  for (const d of ['dead', 'sparse', 'normal', 'dense', 'horde', 'swarm']) {
    const spec = valid();
    spec.worlds[0].density = d;
    assert.deepEqual(validateMapSpec(spec), []);
  }
});

test('density is optional', () => {
  const spec = valid();
  delete spec.worlds[0].density;
  assert.deepEqual(validateMapSpec(spec), []);
});

test('an unknown density is rejected by name', () => {
  const spec = valid();
  spec.worlds[0].density = 'enormous';
  const errors = validateMapSpec(spec);
  assert.ok(errors.some((e) => e.includes('density') && e.includes('enormous')),
    `expected a density error, got ${JSON.stringify(errors)}`);
});

// creature_count is now DERIVED from density by populateWorld. Leaving it
// authorable would give one number two sources of truth, and the spec's copy
// would silently lose.
test('the retired creature_count field is rejected, pointing at density', () => {
  const spec = valid();
  spec.worlds[0].creature_count = 7;
  const errors = validateMapSpec(spec);
  assert.ok(errors.some((e) => e.includes('creature_count') && e.includes('density')),
    `expected a creature_count error mentioning density, got ${JSON.stringify(errors)}`);
});

// allows_fast_travel gates map-based travel (Plan B slice 1). It is optional
// and defaults to FALSE, which is the safety property: a world added later is
// not a travel target until someone deliberately says so, so the portal guards
// that gate dungeon entrances cannot be skipped by omission.
test('allows_fast_travel is optional', () => {
  const spec = valid();
  delete spec.worlds[0].allows_fast_travel;
  assert.deepEqual(validateMapSpec(spec), []);
});

test('allows_fast_travel accepts booleans', () => {
  for (const v of [true, false]) {
    const spec = valid();
    spec.worlds[0].allows_fast_travel = v;
    assert.deepEqual(validateMapSpec(spec), []);
  }
});

// Rejected rather than coerced. "true"/1 are the two ways a hand-edited spec
// expresses this wrongly, and silently coercing either would flag a world as a
// travel target on the strength of a typo.
test('a non-boolean allows_fast_travel is rejected', () => {
  for (const bad of ['true', 1, 'yes', null]) {
    const spec = valid();
    spec.worlds[0].allows_fast_travel = bad;
    const errors = validateMapSpec(spec);
    assert.ok(errors.some((e) => e.includes('allows_fast_travel')),
      `expected an allows_fast_travel error for ${JSON.stringify(bad)}, got ${JSON.stringify(errors)}`);
  }
});

// Unlike is_entry, MANY worlds may carry it -- it is not mutually exclusive,
// so there is no "exactly one" rule and no clear-the-others step on seed.
test('several worlds may allow fast travel at once', () => {
  const spec = valid();
  spec.worlds[0].allows_fast_travel = true;
  spec.worlds[1].allows_fast_travel = true;
  assert.deepEqual(validateMapSpec(spec), []);
});
