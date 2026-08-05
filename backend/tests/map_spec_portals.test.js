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

test('two portals converging on the same ARRIVAL tile is rejected', () => {
  // Neither declared `from` slot collides, so the old declared-side-only
  // check passed this clean -- but setPortalLink writes a mirror row at
  // (to, to_x, to_y) for each, and both mirrors land on surface(1050,1050).
  // The second upsert overwrites the first, so dungeon-1's way back up
  // silently becomes dungeon-1b's, and dungeon-1 ships one-way.
  const spec = baseSpec();
  spec.worlds.push(
    { key: 'dungeon-1', name: 'Dungeon Level 1', width: 20, height: 20 },
    { key: 'dungeon-1b', name: 'Dungeon Level 1 Alt', width: 20, height: 20 },
  );
  spec.links.push(
    { kind: 'portal', from: 'dungeon-1', from_x: 550, from_y: 550, to: 'surface', to_x: 1050, to_y: 1050 },
    { kind: 'portal', from: 'dungeon-1b', from_x: 550, from_y: 550, to: 'surface', to_x: 1050, to_y: 1050 },
  );
  const errors = validateMapSpec(spec);
  assert.ok(errors.some((e) => /already has a portal on tile \(1050,1050\)/.test(e)),
    `expected an arrival-tile collision error, got: ${JSON.stringify(errors)}`);
});

test("a portal's arrival tile colliding with another portal's DEPARTURE tile is rejected", () => {
  // Mixed sides: surface(1050,1050) is dungeon-1's declared arrival AND
  // dungeon-2's declared departure. One row, two claimants, same overwrite.
  const spec = baseSpec();
  spec.worlds.push(
    { key: 'dungeon-1', name: 'Dungeon Level 1', width: 20, height: 20 },
    { key: 'dungeon-2', name: 'Dungeon Level 2', width: 20, height: 20 },
  );
  spec.links.push(
    { kind: 'portal', from: 'dungeon-1', from_x: 550, from_y: 550, to: 'surface', to_x: 1050, to_y: 1050 },
    { kind: 'portal', from: 'surface', from_x: 1050, from_y: 1050, to: 'dungeon-2', to_x: 550, to_y: 550 },
  );
  const errors = validateMapSpec(spec);
  assert.ok(errors.some((e) => /already has a portal on tile \(1050,1050\)/.test(e)),
    `expected a departure/arrival collision error, got: ${JSON.stringify(errors)}`);
});

test('distinct arrival tiles for two branches back to the same hub validate clean', () => {
  // The counter-case: same hub world, DIFFERENT staircase tiles. Nothing
  // overwrites anything, so this must not be flagged.
  const spec = baseSpec();
  spec.worlds.push(
    { key: 'dungeon-1', name: 'Dungeon Level 1', width: 20, height: 20 },
    { key: 'dungeon-1b', name: 'Dungeon Level 1 Alt', width: 20, height: 20 },
  );
  spec.links.push(
    { kind: 'portal', from: 'dungeon-1', from_x: 550, from_y: 550, to: 'surface', to_x: 1050, to_y: 1050 },
    { kind: 'portal', from: 'dungeon-1b', from_x: 550, from_y: 550, to: 'surface', to_x: 1950, to_y: 1050 },
  );
  assert.deepStrictEqual(validateMapSpec(spec), []);
});

test('redundantly declaring both directions of one portal is not a conflict', () => {
  // Both declarations produce byte-identical rows, so the second write
  // destroys nothing -- flagging it would reject a legal (if verbose) spec.
  const spec = baseSpec();
  spec.worlds.push({ key: 'dungeon-1', name: 'Dungeon Level 1', width: 20, height: 20 });
  spec.links.push(
    { kind: 'portal', from: 'surface', from_x: 1050, from_y: 1050, to: 'dungeon-1', to_x: 550, to_y: 550 },
    { kind: 'portal', from: 'dungeon-1', from_x: 550, from_y: 550, to: 'surface', to_x: 1050, to_y: 1050 },
  );
  assert.deepStrictEqual(validateMapSpec(spec), []);
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

test('a grid-less non-portal world with missing width reports only the grid error (continue behavior)', () => {
  const spec = baseSpec();
  // A grid-less world with no portal link connecting it -- not even "unreachable" since
  // it has no grid and we continue after the grid error without recording adjacency.
  spec.worlds.push({ key: 'orphan', name: 'Orphan', height: 20 });
  const errors = validateMapSpec(spec);
  // Should report only errors that stem from the grid being invalid; since we continue
  // after the grid error, the width check is skipped (matching pre-portal behavior).
  // It will still be flagged as unreachable since it has no links, but that's a
  // second error from reachability, not from width validation.
  assert.ok(errors.some((e) => /grid must be two integers/.test(e)));
  // Verify the width error is NOT present (the continue statement skipped it)
  assert.ok(!errors.some((e) => /width must be an integer/.test(e)));
});
