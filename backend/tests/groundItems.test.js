const test = require('node:test');
const assert = require('node:assert');
const { GroundItemSim, PICKUP_RADIUS } = require('../src/authority/groundItems');

const CHUNK = 64; // chunk_size; chunk span = 64 * 100 = 6400px

function rows(...specs) {
  return specs.map(([id, x, y, typeId = 1, expires = '2999-01-01T00:00:00Z', rarity]) =>
    ({ id, x, y, item_type_id: typeId, expires_at: expires, rarity }));
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
    { id: 'a', typeId: 7, x: 100, y: 200, expiresAt: undefined, rarity: 'white' },
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

test('removeExpired removes only expired items and returns their id AND position', () => {
  const sim = new GroundItemSim(CHUNK);
  sim.add(rows(['old', 100, 100, 1, '2000-01-01T00:00:00Z'], ['new', 120, 120]));
  const removed = sim.removeExpired(Date.parse('2020-01-01T00:00:00Z'));
  // SOMET-482: the position is what the despawn puff is drawn at. An id alone
  // cannot be placed, because the entry is gone from the map by the time the
  // caller looks at the return value.
  assert.deepStrictEqual(removed, [{ id: 'old', x: 100, y: 100 }]);
  assert.strictEqual(sim.count(), 1);
});

test('snapshotForNeighborhood emits only in-neighborhood items, wire shape only', () => {
  const sim = new GroundItemSim(CHUNK);
  sim.add(rows(['in', 100, 100, 3], ['out', 20000, 20000, 3]));
  const snap = sim.snapshotForNeighborhood(['0,0']);
  assert.deepStrictEqual(snap, [{ id: 'in', typeId: 3, x: 100, y: 100, rarity: 'white' }]);
});

// ---------------------------------------------------------------------------
// SOMET-490: the rarity grade is part of a ground item's identity, not a
// lookup the renderer can do later. Nothing else in the process holds a
// dropped item's grade once flushAndPrune has run, so if this Map does not
// carry it, no amount of client work can put the glow back.
// ---------------------------------------------------------------------------

test('add carries the rarity grade off the DB row', () => {
  const sim = new GroundItemSim(CHUNK);
  sim.add(rows(['f', 100, 100, 7, '2999-01-01T00:00:00Z', 'foxy']));
  assert.strictEqual(sim.get('f').rarity, 'foxy');
});

test('a missing or unrecognised grade normalises to white, never undefined', () => {
  const sim = new GroundItemSim(CHUNK);
  // A gold pile: its INSERT never names the rarity column at all. Pre-SOMET-480
  // rows behave the same way.
  sim.add(rows(['gold', 100, 100]));
  // A grade world_items' CHECK constraint would reject -- a typo, or a column
  // renamed out from under this code.
  sim.add([{ id: 'junk', x: 100, y: 100, item_type_id: 1, rarity: 'legendary' }]);
  assert.strictEqual(sim.get('gold').rarity, 'white');
  assert.strictEqual(sim.get('junk').rarity, 'white');
});

test('snapshotForNeighborhood puts the grade on the wire', () => {
  const sim = new GroundItemSim(CHUNK);
  sim.add(rows(['f', 100, 100, 3, '2999-01-01T00:00:00Z', 'foxy']));
  assert.deepStrictEqual(
    sim.snapshotForNeighborhood(['0,0']),
    [{ id: 'f', typeId: 3, x: 100, y: 100, rarity: 'foxy' }],
  );
});

test('a deactivate/reactivate cycle re-reads the grade rather than losing it', () => {
  const sim = new GroundItemSim(CHUNK);
  const dbRow = rows(['f', 100, 100, 3, '2999-01-01T00:00:00Z', 'foxy']);
  sim.add(dbRow);
  // The player walks away: the chunk leaves the active set and the entry is
  // forgotten entirely (pruneInactive's contract).
  assert.strictEqual(sim.pruneInactive(new Set()), 1);
  assert.strictEqual(sim.get('f'), null);
  // They walk back: activateChunk re-SELECTs the SAME row. The grade has to
  // survive that round trip, or the glow blinks out and reads as a render bug.
  sim.add(dbRow);
  assert.strictEqual(sim.snapshotForNeighborhood(['0,0'])[0].rarity, 'foxy');
});
