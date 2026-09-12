const test = require('node:test');
const assert = require('node:assert');
const { validateMapSpec } = require('../seeds/mapSpec.js');

// Minimal valid two-world spec with one portal. Copy the smallest fixture
// shape from map_spec_fixtures.test.js if this one fails a rule unrelated to
// art -- the point of these tests is the art rules only.
function base() {
  return {
    name: 't', topology: 'grid',
    worlds: [
      { key: 'a', name: 'A', grid: [0, 0], seed: 1, width: 40, height: 40, chunk_size: 8, biomes: ['meadow'], is_entry: true, entry_spawn: { x: 1250, y: 1150 },
        waypoints: [{ x: 2050, y: 2050, name: 'Stone A' }],
        village: { key: 'v1', min_row: 10, min_col: 10, width: 6, height: 4, gate_edge: 'S', spawn_x: 1250, spawn_y: 1150 },
        chest: { x: 3050, y: 3050, level: 2, guard_creature_type: 'Wolf' } },
      { key: 'b', name: 'B', seed: 2, width: 40, height: 40, chunk_size: 8, biomes: ['meadow'] },
    ],
    links: [{ kind: 'portal', from: 'a', to: 'b', from_x: 550, from_y: 1550, to_x: 550, to_y: 550 }],
  };
}
const TYPES = new Map([
  ['portal', 'portal'], ['stone_gate', 'portal'], ['waypoint_stone', 'waypoint'],
  ['merchant_post', 'merchant'], ['bank_post', 'bank'], ['chest_vault', 'chest_vault'], ['pine_tree', undefined],
]);
const artErrors = (spec, types = TYPES) =>
  validateMapSpec(spec, { pointArtTypes: types }).filter((e) => /art/.test(e));

test('a spec with no art fields raises no art errors', () => {
  assert.deepStrictEqual(artErrors(base()), []);
});

test('portal, waypoint, chest and village art of the right kind pass', () => {
  const s = base();
  s.links[0].art = 'stone_gate';
  s.worlds[0].waypoints[0].art = 'waypoint_stone';
  s.worlds[0].chest.art = 'chest_vault';
  s.worlds[0].village.art = { merchant: 'merchant_post', bank: 'bank_post' };
  assert.deepStrictEqual(artErrors(s), []);
});

test('a portal art of another kind is rejected naming the link and the kind', () => {
  const s = base();
  s.links[0].art = 'pine_tree';
  const errs = artErrors(s);
  assert.strictEqual(errs.length, 1);
  assert.match(errs[0], /portal link a->b art "pine_tree" is not an entity type of point kind "portal"/);
});

test('an unknown name is rejected', () => {
  const s = base();
  s.worlds[0].chest.art = 'no_such_type';
  assert.match(artErrors(s)[0], /world "a" chest art "no_such_type" is not an entity type of point kind "chest_vault"/);
});

test('village art keys are limited to the four posts and each checks its own kind', () => {
  const s = base();
  s.worlds[0].village.art = { merchant: 'bank_post', tavern: 'merchant_post' };
  const errs = artErrors(s);
  assert.ok(errs.some((e) => /village "v1" art merchant "bank_post" is not an entity type of point kind "merchant"/.test(e)), errs.join('\n'));
  assert.ok(errs.some((e) => /village "v1" art has unknown key "tavern"/.test(e)), errs.join('\n'));
});

test('waypoint_art without is_waypoint is rejected; with it, kind waypoint is required', () => {
  const s = base();
  s.links[0].waypoint_art = 'waypoint_stone';
  assert.match(artErrors(s)[0], /portal link a->b waypoint_art requires is_waypoint: true/);
  s.links[0].is_waypoint = true; s.links[0].waypoint_name = 'Gate A';
  delete s.worlds[0].waypoints; // one waypoint per world
  assert.deepStrictEqual(artErrors(s), []);
  s.links[0].waypoint_art = 'stone_gate';
  assert.match(artErrors(s)[0], /waypoint_art "stone_gate" is not an entity type of point kind "waypoint"/);
});

test('a non-string art is a shape error even with no catalog', () => {
  const s = base();
  s.links[0].art = 7;
  assert.match(artErrors(s, null)[0], /portal link a->b art must be an entity type name/);
});

test('with no catalog, a well-formed name passes (seed-map supplies the catalog)', () => {
  const s = base();
  s.links[0].art = 'anything';
  assert.deepStrictEqual(artErrors(s, null), []);
});
