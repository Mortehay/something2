const test = require('node:test');
const assert = require('node:assert');
const { validateMapSpec } = require('../seeds/mapSpec.js');

function baseSpec() {
  return {
    worlds: [
      { key: 'surface', name: 'Surface', grid: [0, 0], width: 20, height: 20, is_entry: true },
    ],
    links: [],
  };
}

test('a world with no grid is rejected unless it is a portal endpoint', () => {
  const spec = baseSpec();
  spec.worlds.push({ key: 'dungeon-1', name: 'Dungeon Level 1', width: 20, height: 20 });
  const errors = validateMapSpec(spec);
  assert.ok(errors.some((e) => /dungeon-1.*grid/.test(e)),
    'a grid-less world with no portal link must still fail, same as today');
});

test('a portal-connected world may omit grid entirely', () => {
  const spec = baseSpec();
  spec.worlds.push({ key: 'dungeon-1', name: 'Dungeon Level 1', width: 20, height: 20 });
  spec.links.push({
    kind: 'portal', from: 'surface', from_x: 1050, from_y: 1050,
    to: 'dungeon-1', to_x: 550, to_y: 550,
  });
  const errors = validateMapSpec(spec);
  assert.deepStrictEqual(errors, []);
});

test('a portal link requires all four integer coordinates', () => {
  const spec = baseSpec();
  spec.worlds.push({ key: 'dungeon-1', name: 'Dungeon Level 1', width: 20, height: 20 });
  spec.links.push({ kind: 'portal', from: 'surface', from_x: 1050, to: 'dungeon-1', to_x: 550, to_y: 550 });
  const errors = validateMapSpec(spec);
  assert.ok(errors.some((e) => /portal.*from_y/.test(e)));
});

test('branching: one world may have two outgoing portals', () => {
  const spec = baseSpec();
  spec.worlds.push(
    { key: 'dungeon-1', name: 'Dungeon Level 1', width: 20, height: 20 },
    { key: 'dungeon-1b', name: 'Dungeon Level 1 Alt', width: 20, height: 20 },
  );
  spec.links.push(
    { kind: 'portal', from: 'surface', from_x: 1050, from_y: 1050, to: 'dungeon-1', to_x: 550, to_y: 550 },
    { kind: 'portal', from: 'surface', from_x: 1950, from_y: 1050, to: 'dungeon-1b', to_x: 550, to_y: 550 },
  );
  const errors = validateMapSpec(spec);
  assert.deepStrictEqual(errors, []);
});

test('two portals from the same world at the same tile is rejected', () => {
  const spec = baseSpec();
  spec.worlds.push(
    { key: 'dungeon-1', name: 'Dungeon Level 1', width: 20, height: 20 },
    { key: 'dungeon-1b', name: 'Dungeon Level 1 Alt', width: 20, height: 20 },
  );
  spec.links.push(
    { kind: 'portal', from: 'surface', from_x: 1050, from_y: 1050, to: 'dungeon-1', to_x: 550, to_y: 550 },
    { kind: 'portal', from: 'surface', from_x: 1050, from_y: 1050, to: 'dungeon-1b', to_x: 550, to_y: 550 },
  );
  const errors = validateMapSpec(spec);
  assert.ok(errors.some((e) => /already has a portal/.test(e)));
});

test('a dungeon level unreachable from the entry (no portal, no grid link) is still rejected', () => {
  const spec = baseSpec();
  spec.worlds.push({ key: 'dungeon-orphan', name: 'Orphan', width: 20, height: 20 });
  // Note: no link at all references dungeon-orphan.
  const errors = validateMapSpec(spec);
  assert.ok(errors.some((e) => /dungeon-orphan.*unreachable/.test(e)));
});

test('reachability BFS walks portal links, not just compass links', () => {
  const spec = baseSpec();
  spec.worlds.push(
    { key: 'dungeon-1', name: 'Dungeon Level 1', width: 20, height: 20 },
    { key: 'dungeon-2', name: 'Dungeon Level 2', width: 20, height: 20 },
  );
  spec.links.push(
    { kind: 'portal', from: 'surface', from_x: 1050, from_y: 1050, to: 'dungeon-1', to_x: 550, to_y: 550 },
    { kind: 'portal', from: 'dungeon-1', from_x: 1050, from_y: 1050, to: 'dungeon-2', to_x: 550, to_y: 550 },
  );
  const errors = validateMapSpec(spec);
  assert.deepStrictEqual(errors, [],
    'dungeon-2 is reachable transitively through two portal hops, not directly from the entry');
});

test('a guard config on a portal is validated: positive integer count', () => {
  const spec = baseSpec();
  spec.worlds.push({ key: 'dungeon-1', name: 'Dungeon Level 1', width: 20, height: 20 });
  spec.links.push({
    kind: 'portal', from: 'surface', from_x: 1050, from_y: 1050,
    to: 'dungeon-1', to_x: 550, to_y: 550,
    guard: { creature_type: 'Orc', count: 0 },
  });
  const errors = validateMapSpec(spec);
  assert.ok(errors.some((e) => /guard.*count/.test(e)));
});

test('a guard config referencing an unknown creature type is rejected when a catalog is supplied', () => {
  const spec = baseSpec();
  spec.worlds.push({ key: 'dungeon-1', name: 'Dungeon Level 1', width: 20, height: 20 });
  spec.links.push({
    kind: 'portal', from: 'surface', from_x: 1050, from_y: 1050,
    to: 'dungeon-1', to_x: 550, to_y: 550,
    guard: { creature_type: 'Nonexistent Beast', count: 2 },
  });
  const errors = validateMapSpec(spec, { creatureTypeNames: new Set(['Orc']) });
  assert.ok(errors.some((e) => /unknown creature type "Nonexistent Beast"/.test(e)));
});

test('a compass-only spec with no portals validates exactly as before (no regression)', () => {
  const spec = baseSpec();
  spec.worlds.push({ key: 'east', name: 'East', grid: [1, 0], width: 20, height: 20 });
  spec.links.push({ from: 'surface', to: 'east', edge: 'E' });
  const errors = validateMapSpec(spec);
  assert.deepStrictEqual(errors, []);
});
