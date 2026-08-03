const test = require('node:test');
const assert = require('node:assert');
const { World } = require('../src/authority/world');

const MAP = { chunkSize: 64, isWalkable: () => true, speedAt: () => 1 };

test('World.tickCreatures surfaces guard kills as kills with a null killer', () => {
  const w = new World(MAP, {}, null, 64);
  w.creatures.addCreatures([
    { id: 'g', type: 'Village Guard', x: 100, y: 100, hp: 300, faction: 'guard', home_x: 100, home_y: 100 },
    { id: 'h', type: 'Slime', x: 140, y: 100, hp: 1 },
  ]);
  const out = w.tickCreatures(0.5, new Set(['0,0']));
  assert.ok(out && Array.isArray(out.kills), 'must return { kills }');
  // A guard has no player behind it: killerUserId must be exactly null, not
  // merely falsy — a stray undefined or 0 must not slip through.
  assert.deepEqual(out.kills, [{ id: 'h', killerUserId: null }]);
  assert.strictEqual(out.kills[0].killerUserId, null);
});

test('tickCreatures returns an empty list when nothing dies', () => {
  const w = new World(MAP, {}, null, 64);
  w.creatures.addCreatures([{ id: 'h', type: 'Slime', x: 0, y: 0, hp: 100 }]);
  const out = w.tickCreatures(0.1, new Set(['0,0']));
  assert.deepEqual(out.kills, []);
});
