const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const spec = require(path.join(__dirname, '../seeds/maps/spire-of-trials.map.json'));
const floorOf = (w) => Number(w.key.slice('spire_f'.length));

// Floors 1-30: a checkpoint every 5; above 30: every 10.
const expected = [5, 10, 15, 20, 25, 30, 40, 50, 60];

test('the Spire has 60 floors chained east, one after the other', () => {
  assert.strictEqual(spec.worlds.length, 60);
  assert.deepStrictEqual(spec.worlds.map(floorOf), Array.from({ length: 60 }, (_, i) => i + 1));
  for (let f = 1; f < 60; f++) {
    const link = spec.links.find((l) => l.edge === 'E' && l.from === `spire_f${String(f).padStart(2, '0')}`);
    assert.ok(link, `floor ${f} must lead east`);
    assert.strictEqual(link.to, `spire_f${String(f + 1).padStart(2, '0')}`);
  }
});

test('checkpoint waypoints sit on floors 5..30 every 5, then every 10', () => {
  const have = spec.worlds.filter((w) => Array.isArray(w.waypoints) && w.waypoints.length).map(floorOf);
  assert.deepStrictEqual(have, expected);
});

test('each checkpoint is one named waypoint for its own floor, and floors share no checkpoint name', () => {
  const names = new Set();
  for (const w of spec.worlds.filter((x) => x.waypoints)) {
    assert.strictEqual(w.waypoints.length, 1, 'one waypoint per world');
    assert.strictEqual(w.waypoints[0].name, `Spire Checkpoint: Floor ${floorOf(w)}`);
    assert.ok(!names.has(w.waypoints[0].name));
    names.add(w.waypoints[0].name);
  }
});

test('the monster level band keeps rising with the floor', () => {
  let prev = -1;
  for (const w of spec.worlds) {
    assert.ok(w.level_band[0] > prev, `floor ${floorOf(w)} must not drop below the floor before it`);
    prev = w.level_band[0];
  }
  assert.ok(spec.worlds[59].level_band[1] <= 150, 'stays under the level cap');
});
