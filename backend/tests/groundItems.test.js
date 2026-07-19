const test = require('node:test');
const assert = require('node:assert');
const { GroundItemSim, PICKUP_RADIUS } = require('../src/authority/groundItems');

const CHUNK = 64; // chunk_size; chunk span = 64 * 100 = 6400px

function rows(...specs) {
  return specs.map(([id, x, y, typeId = 1, expires = '2999-01-01T00:00:00Z']) =>
    ({ id, x, y, item_type_id: typeId, expires_at: expires }));
}

test('PICKUP_RADIUS matches the dagger reach', () => {
  assert.strictEqual(PICKUP_RADIUS, 80);
});

test('add dedups by id and normalizes fields', () => {
  const sim = new GroundItemSim(CHUNK);
  sim.add(rows(['a', 100, 200, 7]));
  sim.add(rows(['a', 999, 999, 9])); // same id -> ignored
  assert.strictEqual(sim.count(), 1);
  assert.deepStrictEqual(
    { ...sim.get('a'), expiresAt: undefined },
    { id: 'a', typeId: 7, x: 100, y: 200, expiresAt: undefined },
  );
});

test('nearest returns the closest within radius, null beyond it', () => {
  const sim = new GroundItemSim(CHUNK);
  sim.add(rows(['far', 100, 170], ['near', 100, 140], ['out', 100, 300]));
  assert.strictEqual(sim.nearest(100, 100, PICKUP_RADIUS).id, 'near');
  assert.strictEqual(sim.nearest(100, 100, 10), null);
});

test('within returns every item in range', () => {
  const sim = new GroundItemSim(CHUNK);
  sim.add(rows(['a', 100, 140], ['b', 100, 170], ['c', 100, 300]));
  const ids = sim.within(100, 100, PICKUP_RADIUS).map((i) => i.id).sort();
  assert.deepStrictEqual(ids, ['a', 'b']);
});

test('pruneInactive drops items outside the active chunk set', () => {
  const sim = new GroundItemSim(CHUNK);
  sim.add(rows(['keep', 100, 100], ['drop', 20000, 20000]));
  const dropped = sim.pruneInactive(new Set(['0,0']));
  assert.strictEqual(dropped, 1);
  assert.strictEqual(sim.get('keep').id, 'keep');
  assert.strictEqual(sim.get('drop'), null);
});

test('removeExpired removes only expired items and returns their ids', () => {
  const sim = new GroundItemSim(CHUNK);
  sim.add(rows(['old', 100, 100, 1, '2000-01-01T00:00:00Z'], ['new', 120, 120]));
  const removed = sim.removeExpired(Date.parse('2020-01-01T00:00:00Z'));
  assert.deepStrictEqual(removed, ['old']);
  assert.strictEqual(sim.count(), 1);
});

test('snapshotForNeighborhood emits only in-neighborhood items, wire shape only', () => {
  const sim = new GroundItemSim(CHUNK);
  sim.add(rows(['in', 100, 100, 3], ['out', 20000, 20000, 3]));
  const snap = sim.snapshotForNeighborhood(['0,0']);
  assert.deepStrictEqual(snap, [{ id: 'in', typeId: 3, x: 100, y: 100 }]);
});
