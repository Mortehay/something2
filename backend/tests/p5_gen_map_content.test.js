const test = require('node:test');
const assert = require('node:assert');
const {
  generateSpec, portalCenterPx, entryVillageBox, villageKeyFor,
} = require('../scripts/dungeon/gen-p5-map-content');

test('generates a spec with exactly one is_entry world', () => {
  const spec = generateSpec();
  const entries = spec.worlds.filter((w) => w.is_entry === true);
  assert.equal(entries.length, 1);
});

test('generates 8 dungeons worth of rooms plus 10 surface worlds, all with unique names and grid cells', () => {
  const spec = generateSpec();
  const names = new Set(spec.worlds.map((w) => w.name));
  assert.equal(names.size, spec.worlds.length, 'world names must be unique');
  const cells = new Set(spec.worlds.map((w) => w.grid.join(',')));
  assert.equal(cells.size, spec.worlds.length, 'grid cells must be unique');
  const surfaceWorlds = spec.worlds.filter((w) => w.key.startsWith('surface_'));
  assert.equal(surfaceWorlds.length, 10);
  assert.ok(spec.worlds.length - surfaceWorlds.length >= 40, 'expected roughly 48-53 dungeon rooms');
});

test('every new world grid.x is >= 20 (collision avoidance with the 3 existing specs)', () => {
  const spec = generateSpec();
  for (const w of spec.worlds) {
    assert.ok(w.grid[0] >= 20, `world "${w.name}" has grid.x ${w.grid[0]}, expected >= 20`);
  }
});

test('exactly 7 inter-dungeon portal links, each carrying a guard', () => {
  const spec = generateSpec();
  const portals = spec.links.filter((l) => l.kind === 'portal');
  assert.equal(portals.length, 7);
  for (const p of portals) {
    assert.ok(p.guard && typeof p.guard.creature_type === 'string' && p.guard.count >= 1);
    assert.ok(Number.isInteger(p.from_x) && Number.isInteger(p.from_y));
    assert.ok(Number.isInteger(p.to_x) && Number.isInteger(p.to_y));
  }
});

test('level_band floor and ceiling are both non-decreasing across the dungeon chain, by dungeon order', () => {
  const spec = generateSpec();
  const byKey = new Map(spec.worlds.map((w) => [w.key, w]));
  // Every dungeon's designated exit room must have a band floor/ceiling >=
  // the previous dungeon's exit room -- a coarse, cheap proxy for the real
  // BFS-hop check map_spec_fixtures.test.js performs on the assembled spec.
  const exitKeys = ['d1_end', 'd2_subBranch', 'd3_heart', 'd4_end', 'd5_subBranch', 'd6_heart', 'd7_end', 'd8_subBranch'];
  let prevMin = -Infinity, prevMax = -Infinity;
  for (const k of exitKeys) {
    const w = byKey.get(k);
    assert.ok(w, `expected exit room "${k}" to exist`);
    assert.ok(w.level_band[0] >= prevMin);
    assert.ok(w.level_band[1] >= prevMax);
    prevMin = w.level_band[0]; prevMax = w.level_band[1];
  }
});

test('every world declares a level_band and a density', () => {
  const spec = generateSpec();
  for (const w of spec.worlds) {
    assert.ok(Array.isArray(w.level_band) && w.level_band.length === 2, `${w.name} missing level_band`);
    assert.equal(typeof w.density, 'string', `${w.name} missing density`);
  }
});

// These two functions replace constants that were the same expressions
// hand-evaluated at size 64. At 64 they must still produce exactly the old
// literals, or this refactor silently moved every portal arrival in the spec.
test('portalCenterPx(64) reproduces the old PORTAL_TILE_PX literal', () => {
  assert.equal(portalCenterPx(64), 3250);
});

test('portalCenterPx scales to the centre tile of any world size', () => {
  assert.equal(portalCenterPx(96), 4850);
  assert.equal(portalCenterPx(128), 6450);
  assert.equal(portalCenterPx(224), 11250);
});

test('entryVillageBox(64) reproduces the old hand-written village literal', () => {
  assert.deepEqual(entryVillageBox(64, 'underdeep-hub'), {
    key: 'underdeep-hub',
    min_row: 28, min_col: 28, width: 6, height: 4, gate_edge: 'S',
    spawn_x: 3050, spawn_y: 2950,
  });
});

test('entryVillageBox stays centred as the world grows', () => {
  assert.deepEqual(entryVillageBox(128, 'abyss-hub'), {
    key: 'abyss-hub',
    min_row: 60, min_col: 60, width: 6, height: 4, gate_edge: 'S',
    spawn_x: 6250, spawn_y: 6150,
  });
});

// SOMET-451. The generator had never emitted village `key`, so regenerating
// p5-descent dropped all three and produced a spec validateMapSpec rejects
// (`key` is REQUIRED since SOMET-312 -- it is what lets a re-seed MOVE a
// village). These three strings are the ones that were hand-written into the
// checked-in spec, so this pins that deriving them is not a rename.
test('villageKeyFor reproduces the hand-written village keys', () => {
  assert.equal(villageKeyFor('The Underdeep: Hub'), 'underdeep-hub');
  assert.equal(villageKeyFor('The Frozen Vaults: Hub'), 'frozen-vaults-hub');
  assert.equal(villageKeyFor('The Abyss: Hub'), 'abyss-hub');
});

test('every generated village declares a non-empty key', () => {
  const spec = generateSpec();
  const villages = spec.worlds.filter((w) => w.village);
  assert.ok(villages.length >= 3, `expected the hub dungeons to carry villages, found ${villages.length}`);
  for (const w of villages) {
    assert.equal(typeof w.village.key, 'string', `world "${w.key}" village key is not a string`);
    assert.ok(w.village.key.length > 0, `world "${w.key}" village key is empty`);
  }
});

test('world size varies with depth instead of being uniformly 64', () => {
  const spec = generateSpec();
  const sizes = new Set(spec.worlds.map((w) => w.width));
  assert.ok(sizes.size > 1, 'every world still has the same width');
  for (const w of spec.worlds) {
    assert.equal(w.width, w.height, `world "${w.key}" is not square`);
    assert.equal(w.width % 32, 0, `world "${w.key}" is not a whole number of chunks`);
    assert.ok(w.width >= 96 && w.width <= 224,
      `world "${w.key}" has width ${w.width}, outside the ramp`);
  }
});

test('the deepest dungeon room is larger than the entry room', () => {
  const spec = generateSpec();
  const entry = spec.worlds.find((w) => w.is_entry === true);
  const deepest = spec.worlds.reduce((a, b) => (b.width > a.width ? b : a));
  assert.ok(deepest.width > entry.width,
    `entry is ${entry.width} and the largest world is ${deepest.width}`);
});

test('every portal coordinate sits inside the world it belongs to', () => {
  const spec = generateSpec();
  const byKey = new Map(spec.worlds.map((w) => [w.key, w]));
  for (const l of spec.links.filter((x) => x.kind === 'portal')) {
    const from = byKey.get(l.from);
    const to = byKey.get(l.to);
    assert.ok(l.from_x >= 0 && l.from_y >= 0 && l.from_x < from.width * 100 && l.from_y < from.height * 100,
      `portal departure (${l.from_x},${l.from_y}) is outside ${l.from} (${from.width} tiles)`);
    assert.ok(l.to_x >= 0 && l.to_y >= 0 && l.to_x < to.width * 100 && l.to_y < to.height * 100,
      `portal arrival (${l.to_x},${l.to_y}) is outside ${l.to} (${to.width} tiles)`);
  }
});

test('the entry spawn sits at the centre of the entry world, whatever its size', () => {
  const spec = generateSpec();
  const entry = spec.worlds.find((w) => w.is_entry === true);
  assert.deepEqual(entry.entry_spawn,
    { x: portalCenterPx(entry.width), y: portalCenterPx(entry.width) });
});

test('a stamped entry village stays inside its world and carries no marker field', () => {
  const spec = generateSpec();
  for (const w of spec.worlds.filter((x) => x.village)) {
    assert.ok(w.village.min_row + w.village.height <= w.height,
      `village in "${w.key}" overruns the world`);
    assert.ok(w.village.min_col + w.village.width <= w.width,
      `village in "${w.key}" overruns the world`);
    assert.equal(w._needsVillage, undefined, `"${w.key}" leaked its marker field`);
  }
});
