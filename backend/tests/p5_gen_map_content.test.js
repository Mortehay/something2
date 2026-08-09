const test = require('node:test');
const assert = require('node:assert');
const { generateSpec } = require('../scripts/dungeon/gen-p5-map-content');

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
