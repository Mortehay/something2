const test = require('node:test');
const assert = require('node:assert');
const { CreatureSim } = require('../src/authority/creatures.js');

// Stub map: everything walkable at speed 1, chunkSize 8 (chunk span = 800 px).
function stubMap(blockAll = false) {
  return { isWalkable: () => !blockAll, speedAt: () => 1, chunkSize: 8 };
}
// Deterministic rng: never redirect (>=0.02), fixed dir index 0 (east).
const noRedirect = () => 0.99;

test('addCreatures dedups by id', () => {
  const s = new CreatureSim(stubMap(), noRedirect);
  s.addCreatures([{ id: 'a', type: 'Wolf', x: 100, y: 100, hp: 10, facing: 'S', color: '#c0392b' }]);
  s.addCreatures([{ id: 'a', type: 'Wolf', x: 999, y: 999, hp: 10 }]);
  assert.equal(s.count(), 1);
  assert.equal(s.all()[0].x, 100); // second (same id) ignored
});

test('tick roams a creature whose chunk is active', () => {
  const s = new CreatureSim(stubMap(), noRedirect); // dir 0 = east
  s.addCreatures([{ id: 'a', type: 'Wolf', x: 100, y: 100, hp: 10 }]);
  s.tick(0.1, new Set(['0,0'])); // (100,100)→chunk(0,0) active
  const c = s.all()[0];
  assert.ok(c.x > 100, 'moved east');
  assert.equal(c.facing, 'E');
  assert.deepEqual(s.getDirty().map((d) => d.id), ['a']);
});

test('tick freezes a creature whose chunk is NOT active', () => {
  const s = new CreatureSim(stubMap(), noRedirect);
  s.addCreatures([{ id: 'a', type: 'Wolf', x: 100, y: 100, hp: 10 }]);
  s.tick(0.1, new Set(['5,5'])); // (100,100)→chunk(0,0) NOT active
  assert.equal(s.all()[0].x, 100);
  assert.equal(s.getDirty().length, 0);
});

test('blocked creature turns instead of moving', () => {
  const s = new CreatureSim(stubMap(true), noRedirect); // block everything
  s.addCreatures([{ id: 'a', type: 'Wolf', x: 100, y: 100, hp: 10 }]);
  s.tick(0.1, new Set(['0,0']));
  assert.equal(s.all()[0].x, 100); // didn't move
});

test('pruneInactive drops non-dirty out-of-active creatures, keeps dirty', () => {
  const s = new CreatureSim(stubMap(), noRedirect);
  s.addCreatures([
    { id: 'clean', type: 'Wolf', x: 100, y: 100, hp: 10 },
    { id: 'dirty', type: 'Wolf', x: 120, y: 120, hp: 10 },
  ]);
  s.tick(0.1, new Set(['0,0'])); // both in chunk(0,0), both become dirty
  s.clearDirty(['clean']);       // only 'clean' confirmed persisted
  const dropped = s.pruneInactive(new Set(['9,9'])); // chunk(0,0) now inactive
  assert.equal(dropped, 1);
  assert.ok(!s.has('clean'));    // clean + inactive → dropped
  assert.ok(s.has('dirty'));     // dirty → kept
});

test('snapshotForNeighborhood filters by current chunk and shape', () => {
  const s = new CreatureSim(stubMap(), noRedirect);
  s.addCreatures([
    { id: 'near', type: 'Wolf', x: 100, y: 100, hp: 10, facing: 'S', color: '#c0392b' },
    { id: 'far', type: 'Wolf', x: 5000, y: 5000, hp: 10 }, // chunk(6,6)
  ]);
  const snap = s.snapshotForNeighborhood(new Set(['0,0']));
  assert.equal(snap.length, 1);
  assert.equal(snap[0].id, 'near');
  assert.deepEqual(Object.keys(snap[0]).sort(), ['color', 'facing', 'hp', 'id', 'type', 'x', 'y']);
});
