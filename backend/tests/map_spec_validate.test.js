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
    // World `a` is the entry world, so SOMET-335 also requires entry_spawn to
    // BE this village's spawn. Aligned here so gate_edge stays the only broken
    // field and the errs.length === 1 assertion below keeps its meaning.
    s.worlds[0].entry_spawn = { x: 500, y: 600 };
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

// SOMET-288: several villages per world, plus safe-territory fields.
// A legal 6x4 village whose spawn is genuinely interior. Cloned per case so a
// mutation in one test cannot leak into another.
const VILLAGE_A = () => ({
  min_row: 10, min_col: 10, width: 6, height: 4, gate_edge: 'S',
  spawn_x: 1150, spawn_y: 1150,
});
const VILLAGE_B = () => ({
  min_row: 30, min_col: 30, width: 6, height: 4, gate_edge: 'S',
  spawn_x: 3150, spawn_y: 3150,
});

// SOMET-335. `valid()`'s world `a` is the ENTRY world, and an entry world that
// declares a village must carry that village's spawn as its entry_spawn. The
// tests below are about village VALIDITY, not about entry semantics, but they
// hang their village on world `a` -- so each aligns entry_spawn with the
// village it declares. Without this they would all fail on a second, unrelated
// error and stop covering what they are named for.
const alignEntrySpawn = (world, village) => {
  world.entry_spawn = { x: village.spawn_x, y: village.spawn_y };
};

test('a world may declare several villages', () => {
  assert.deepEqual(errorsFor((s) => {
    s.worlds[0].villages = [VILLAGE_A(), VILLAGE_B()];
    alignEntrySpawn(s.worlds[0], VILLAGE_A());
  }), []);
});

test('the singular village key still validates unchanged', () => {
  // 20+ checked-in specs use it. This feature must not require touching any
  // of them.
  assert.deepEqual(errorsFor((s) => {
    s.worlds[0].village = VILLAGE_A();
    alignEntrySpawn(s.worlds[0], VILLAGE_A());
  }), []);
});

test('declaring both village and villages is rejected', () => {
  const errs = errorsFor((s) => {
    s.worlds[0].village = VILLAGE_A();
    s.worlds[0].villages = [VILLAGE_B()];
  });
  assert.ok(errs.some((e) => /both "village" and "villages"/.test(e)), errs.join('\n'));
});

// Review finding (Important 1): a typo'd `villages: {...}` (an object, not a
// list) used to fall through villagesOf's `w.village` fallback and validate
// with ZERO errors -- the applier would then create ZERO villages for that
// world, silently. This must be reported, not ignored.
test('a non-array villages value is rejected, not silently ignored', () => {
  const errs = errorsFor((s) => { s.worlds[0].villages = VILLAGE_A(); });
  assert.ok(errs.some((e) => /villages must be an array/.test(e)), errs.join('\n'));
});

test('every village in the array passes the same geometry rules as a lone one', () => {
  // 6+5 = 11 breaks the SOMET-282 screen budget. The SECOND entry must be
  // checked, not just the first -- a rule applied to element 0 of a list is
  // the same half-applied rule in a new costume.
  const errs = errorsFor((s) => {
    s.worlds[0].villages = [VILLAGE_A(), { ...VILLAGE_B(), height: 5 }];
  });
  assert.ok(errs.some((e) => /width \+ height must be at most/.test(e)), errs.join('\n'));
});

test('two villages in one world may not overlap', () => {
  const errs = errorsFor((s) => {
    s.worlds[0].villages = [
      VILLAGE_A(),
      { min_row: 12, min_col: 12, width: 6, height: 4, gate_edge: 'S',
        spawn_x: 1350, spawn_y: 1350 },
    ];
  });
  assert.ok(errs.some((e) => /villages overlap/.test(e)), errs.join('\n'));
});

test('safe_road_radius must be an integer in 0..8', () => {
  for (const bad of [-1, 9, 2.5, '2', true]) {
    const errs = errorsFor((s) => { s.worlds[0].safe_road_radius = bad; });
    assert.ok(errs.some((e) => /safe_road_radius/.test(e)),
      `radius ${JSON.stringify(bad)} was accepted`);
  }
  assert.deepEqual(errorsFor((s) => { s.worlds[0].safe_road_radius = 3; }), []);
});

test('a safe rectangle must be positive and inside the map bounds', () => {
  const errs = errorsFor((s) => {
    s.worlds[0].safe_rects = [{ min_row: 60, min_col: 60, width: 20, height: 20 }];
  });
  assert.ok(errs.some((e) => /safe_rects/.test(e)), errs.join('\n'));

  assert.deepEqual(errorsFor((s) => {
    s.worlds[0].safe_rects = [{ min_row: 10, min_col: 10, width: 4, height: 4 }];
  }), []);
});

// Review finding (Minor): `for (const s of w.safe_rects ?? [])` threw
// TypeError on a non-array safe_rects and aborted validateMapSpec entirely,
// hiding every other error the rest of the spec had. Must be reported
// instead.
test('a non-array safe_rects does not throw and is reported as invalid', () => {
  let errs;
  assert.doesNotThrow(() => {
    errs = errorsFor((s) => {
      s.worlds[0].safe_rects = { min_row: 0, min_col: 0, width: 2, height: 2 };
    });
  });
  assert.ok(errs.some((e) => /safe_rects must be an array/.test(e)), errs.join('\n'));
});

// Fix wave finding (Minor 2): a null entry INSIDE an otherwise well-formed
// villages array threw `Cannot read properties of null (reading 'width')`
// and aborted validateMapSpec entirely, despite the file's own comment
// claiming this class was handled -- only the container was hardened.
test('a null entry inside villages does not throw and is reported as invalid', () => {
  let errs;
  assert.doesNotThrow(() => {
    errs = errorsFor((s) => { s.worlds[0].villages = [null]; });
  });
  assert.ok(errs.some((e) => /villages entry must be an object/.test(e)), errs.join('\n'));
});

// Fix wave finding (Minor 2): same TypeError shape for safe_rects, on
// `s.min_row`.
test('a null entry inside safe_rects does not throw and is reported as invalid', () => {
  let errs;
  assert.doesNotThrow(() => {
    errs = errorsFor((s) => { s.worlds[0].safe_rects = [null]; });
  });
  assert.ok(errs.some((e) => /safe_rects entry must be an object/.test(e)), errs.join('\n'));
});

// Fix wave finding (Minor 3): `w.village ? [w.village] : []` reads
// `village: null` (or `false`) as "no village here" -- zero errors, zero
// villages, silently. That is the SOMET-153 failure class (a village that
// quietly does not exist), for exactly the reason the sibling `villages:
// {...}` check above already exists.
test('village: null is rejected, not silently read as "no village"', () => {
  const errs = errorsFor((s) => { s.worlds[0].village = null; });
  assert.ok(errs.some((e) => /village must be an object/.test(e)), errs.join('\n'));
});

test('village: false is rejected the same way', () => {
  const errs = errorsFor((s) => { s.worlds[0].village = false; });
  assert.ok(errs.some((e) => /village must be an object/.test(e)), errs.join('\n'));
});

// ---------------------------------------------------------------------------
// Unknown world keys (SOMET-288 review, finding 2).
//
// An unread key is indistinguishable from a consumed one from the author's
// side: the spec validates, the seed exits 0, and the feature is simply absent.
// `pens:` is the live case -- SOMET-288 ships without a pen reader on purpose,
// so an author who writes pens before slice B lands its reader gets no pens and
// no complaint.
// ---------------------------------------------------------------------------
test('an unknown world key is rejected rather than silently ignored', () => {
  // `pens` was this test's example while SOMET-288 shipped without a pen
  // reader. SOMET-289 added the reader and the allowlist entry in one change,
  // which is exactly the rule WORLD_KEYS states, so the example moved to a key
  // that genuinely has no reader.
  const errs = errorsFor((s) => {
    s.worlds[0].waypoint_network = [{ x: 20, y: 20 }];
  });
  assert.ok(errs.some((e) => /unknown key\(s\) waypoint_network/.test(e)), errs.join('\n'));
});

test('a typo\'d world key is named, and every offending key is listed at once', () => {
  // `saferoad_radius` is the realistic shape of this mistake: near-miss on a
  // real key, so the world reads as opted in and is not.
  const errs = errorsFor((s) => {
    s.worlds[0].saferoad_radius = 3;
    s.worlds[0].villagse = [];
  });
  const hit = errs.filter((e) => /unknown key/.test(e));
  assert.equal(hit.length, 1, 'one error per world, not one per key');
  assert.match(hit[0], /saferoad_radius/);
  assert.match(hit[0], /villagse/);
  assert.match(hit[0], /world "a"/, 'the error must name the world');
});

test('every key the applier actually reads is accepted', () => {
  // The allowlist is only as good as its completeness -- a missing entry here
  // turns this check into a wall in front of a legitimate spec. Enumerated
  // explicitly rather than derived from WORLD_KEYS, which would make the
  // assertion true by construction whatever that set contained.
  const errs = errorsFor((s) => {
    Object.assign(s.worlds[0], {
      chunk_size: 64, density: 'sparse', level_band: [1, 3],
      allows_fast_travel: true,
      safe_road_radius: 2,
      safe_rects: [{ min_row: 10, min_col: 10, width: 4, height: 4 }],
      roads: [[[32, 1], [32, 40]]],
      pens: [{ min_row: 40, min_col: 40, width: 4, height: 4,
               creature_type: 'Slime', count: 3, level: 1 }],
      village: { min_row: 20, min_col: 20, width: 6, height: 4, gate_edge: 'S',
                 spawn_x: 2150, spawn_y: 2150 },
      // World `a` is the entry world; SOMET-335 requires entry_spawn to be the
      // spawn of the village it declares. `entry_spawn` is on the allowlist
      // this test enumerates, so setting it is in scope here rather than a
      // workaround.
      entry_spawn: { x: 2150, y: 2150 },
      chest: { x: 500, y: 500, guard_creature_type: 'Wolf', level: 3 },
    });
  });
  assert.deepEqual(errs, []);
});

test('the retired creature_count keeps its own error rather than a generic one', () => {
  // It is on the allowlist deliberately: dropping it there would bury the
  // "use density instead" message under "unknown key".
  const errs = errorsFor((s) => { s.worlds[0].creature_count = 12; });
  assert.ok(errs.some((e) => /no longer authored -- use "density"/.test(e)), errs.join('\n'));
  assert.ok(!errs.some((e) => /unknown key/.test(e)), errs.join('\n'));
});

test('an unknown key on a world that also fails another check is still reported', () => {
  // The grid check `continue`s, so an unknown key checked after it would stay
  // invisible until the author fixed the grid and re-ran.
  const errs = errorsFor((s) => {
    s.worlds[0].grid = null;
    s.worlds[0].waypoint_network = [];
  });
  assert.ok(errs.some((e) => /grid must be two integers/.test(e)), errs.join('\n'));
  assert.ok(errs.some((e) => /unknown key\(s\) waypoint_network/.test(e)), errs.join('\n'));
});

// --- SOMET-289: authored roads and pens -----------------------------------

// A legal village on world `a`, cloned per case. 6x4 at rows 10..13 / cols
// 10..15, so its interior is rows 11..12 and cols 11..14 and spawn
// (1150,1150) = tile (11,11) is genuinely interior.
const B_VILLAGE = () => ({
  min_row: 10, min_col: 10, width: 6, height: 4, gate_edge: 'S',
  spawn_x: 1150, spawn_y: 1150,
});
const B_PEN = () => ({
  min_row: 30, min_col: 30, width: 6, height: 5,
  creature_type: 'Slime', count: 5, level: 1,
});

test('a world may author roads as axis-aligned polylines', () => {
  assert.deepEqual(errorsFor((s) => {
    s.worlds[0].roads = [[[32, 1], [32, 40], [40, 40]], [[5, 5]]];
  }), []);
});

test('a diagonal road segment is rejected rather than guessed at', () => {
  const errs = errorsFor((s) => { s.worlds[0].roads = [[[10, 10], [12, 12]]]; });
  assert.ok(errs.some((e) => /not axis-aligned/.test(e)), errs.join('\n'));
});

test('a road point on or outside the wall ring is rejected', () => {
  // stampBounds overwrites the ring, so such a cell would widen the safe
  // corridor while never being drawn -- the two halves of the feature
  // disagreeing.
  for (const point of [[0, 10], [63, 10], [10, 0], [10, 63], [-1, 10], [10, 99]]) {
    const errs = errorsFor((s) => { s.worlds[0].roads = [[point, [10, 10]]]; });
    assert.ok(errs.some((e) => /strictly inside/.test(e)),
      `point ${JSON.stringify(point)} was accepted: ${errs.join('\n')}`);
  }
});

test('a malformed road point is reported, not thrown on', () => {
  // A throw would abort validateMapSpec entirely and hide every other problem
  // in the spec -- the posture every other check in this file takes.
  for (const roads of [[[[10, '10'], [10, 12]]], [[[10]]], [[]], ['nope'], 'nope']) {
    const errs = errorsFor((s) => { s.worlds[0].roads = roads; });
    assert.ok(errs.length > 0, `${JSON.stringify(roads)} produced no error`);
  }
});

test('a world may author pens', () => {
  assert.deepEqual(errorsFor((s) => { s.worlds[0].pens = [B_PEN()]; }), []);
});

test('a pen is checked by the same geometry function the placer uses', () => {
  const cases = [
    [{ ...B_PEN(), count: 31 }, /exceeds the 6x5/],
    [{ ...B_PEN(), width: 1 }, /width must be between/],
    [{ ...B_PEN(), level: 0 }, /level must be at least 1/],
    [{ ...B_PEN(), min_row: 0 }, /strictly inside/],
    [{ ...B_PEN(), min_row: 60 }, /strictly inside/],
    [null, /pens entry must be an object/],
  ];
  for (const [pen, re] of cases) {
    const errs = errorsFor((s) => { s.worlds[0].pens = [pen]; });
    assert.ok(errs.some((e) => re.test(e)), `accepted ${JSON.stringify(pen)}: ${errs.join('\n')}`);
  }
});

test('a pen referencing an unknown creature type is rejected', () => {
  const spec = valid();
  spec.worlds[0].pens = [{ ...B_PEN(), creature_type: 'Nonexistent Swarm' }];
  const errs = validateMapSpec(spec, { creatureTypeNames: new Set(['Slime', 'Wolf']) });
  assert.ok(errs.some((e) => /unknown creature type "Nonexistent Swarm"/.test(e)), errs.join('\n'));
});

test('a pen overlapping a village is rejected', () => {
  // The placer refuses village tiles, so such a pen silently under-delivers --
  // and anything that did land inside would break the epic's invariant that
  // only Village Guards stand in a village.
  const errs = errorsFor((s) => {
    s.worlds[0].village = B_VILLAGE();
    s.worlds[0].pens = [{ ...B_PEN(), min_row: 12, min_col: 12 }];
  });
  assert.ok(errs.some((e) => /overlaps the village/.test(e)), errs.join('\n'));
});

test('the two new keys are in WORLD_KEYS, so authoring them is not "unknown key"', () => {
  // WORLD_KEYS rejects any key with no reader. `pens` was deliberately held
  // back from SOMET-288 for exactly that reason; both keys have readers now.
  const errs = errorsFor((s) => {
    s.worlds[0].roads = [[[10, 10], [10, 20]]];
    s.worlds[0].pens = [B_PEN()];
  });
  assert.ok(!errs.some((e) => /unknown key/.test(e)), errs.join('\n'));
});

// --- SOMET-335: the entry world's entry_spawn IS its village's spawn -------
//
// `valid()`'s world `a` is the entry world and carries entry_spawn (32,32)
// with no village, so the whole block below turns on what B_VILLAGE() is
// attached to and what entry_spawn is set alongside it. B_VILLAGE()'s spawn is
// (1150,1150), deliberately NOT (32,32), so simply adding the village is
// already the violating case.
//
// Each case asserts on the SPECIFIC message rather than on `errs.length`:
// several of these mutations also trip village geometry or grid checks, and an
// error-count assertion would pass on the wrong error.

const ENTRY_SPAWN_MISMATCH = /entry_spawn \(.*\) is not the spawn of any village/;
const ENTRY_SPAWN_MISSING = /declares a village but no integer entry_spawn/;

test('the entry world may declare a village whose spawn IS its entry_spawn', () => {
  // The shape every hand-authored spec with a starting village must have.
  // deepEqual against [] rather than a negative match: this is also the guard
  // that the new check does not reject the legal case for some other reason.
  assert.deepEqual(errorsFor((s) => {
    s.worlds[0].village = B_VILLAGE();
    s.worlds[0].entry_spawn = { x: 1150, y: 1150 };
  }), []);
});

test("an entry world whose entry_spawn is not its village's spawn is rejected", () => {
  // The defect this check exists for: hub-vale/hub shipped with entry_spawn on
  // the map centre and its village 20 tiles away, and every gate passed. A new
  // character's first join and every respawn landed outside the starting
  // village -- no guards, no merchant, open terrain.
  const errs = errorsFor((s) => { s.worlds[0].village = B_VILLAGE(); });
  assert.ok(errs.some((e) => ENTRY_SPAWN_MISMATCH.test(e)), errs.join('\n'));
});

test('an entry world with a village and no entry_spawn at all is rejected', () => {
  // Absent is the same failure as wrong -- the player still does not start in
  // the village -- so this must not fall through the equality check as a
  // silent pass.
  const errs = errorsFor((s) => {
    s.worlds[0].village = B_VILLAGE();
    delete s.worlds[0].entry_spawn;
  });
  assert.ok(errs.some((e) => ENTRY_SPAWN_MISSING.test(e)), errs.join('\n'));
});

test('a non-integer entry_spawn beside a village is rejected, not silently compared', () => {
  // `{ x: '1150', y: '1150' }` would compare unequal by string interpolation
  // anyway, so it would be caught either way -- but by the WRONG message, which
  // would send the next reader looking for a coordinate mistake instead of a
  // type one. The pixel-string comparison is an implementation detail; the
  // shape check is the contract.
  const errs = errorsFor((s) => {
    s.worlds[0].village = B_VILLAGE();
    s.worlds[0].entry_spawn = { x: '1150', y: '1150' };
  });
  assert.ok(errs.some((e) => ENTRY_SPAWN_MISSING.test(e)), errs.join('\n'));
});

test('the entry world may match ANY of several villages it declares', () => {
  // villagesOf reads the plural `villages` array as well as the singular
  // `village`, and a world is allowed more than one. Requiring the FIRST one
  // would be an invented constraint: the starting village is whichever one the
  // player starts in.
  assert.deepEqual(errorsFor((s) => {
    s.worlds[0].villages = [
      B_VILLAGE(),
      { min_row: 20, min_col: 20, width: 6, height: 4, gate_edge: 'S', spawn_x: 2150, spawn_y: 2150 },
    ];
    s.worlds[0].entry_spawn = { x: 2150, y: 2150 };
  }), []);
});

test('a NON-entry world may hold a village unrelated to any entry_spawn', () => {
  // The check is scoped to the entry world on purpose. Every other village in
  // the game -- four of the five live ones -- has no relationship to
  // entry_spawn whatsoever, and this must not start demanding one.
  assert.deepEqual(errorsFor((s) => { s.worlds[1].village = B_VILLAGE(); }), []);
});

test('an entry world with NO village keeps its entry_spawn unconstrained', () => {
  // loop-catacombs/entry is exactly this shape: is_entry, an entry_spawn on the
  // map centre, and no village anywhere in the spec. The check must not
  // retroactively require a village that was never part of that design.
  // (3250,3250) is this 64x64 fixture's own centre tile -- kept in bounds so
  // this stays a statement about the village rule and not an accidental bet on
  // entry_spawn never being range-checked.
  assert.deepEqual(errorsFor((s) => { s.worlds[0].entry_spawn = { x: 3250, y: 3250 }; }), []);
  assert.deepEqual(errorsFor((s) => { delete s.worlds[0].entry_spawn; }), []);
});
