const test = require('node:test');
const assert = require('node:assert');
const { spireFromRows, floorOf } = require('../src/services/spireProgress.js');

const row = (f, over = {}) => ({ name: `Spire of Trials: Floor ${f}`, boss: f % 5 === 0, seen: false, cleared: false, ...over });
const tower = (n) => Array.from({ length: n }, (_, i) => row(i + 1));

test('floorOf reads only Spire floor names', () => {
  assert.strictEqual(floorOf('Spire of Trials: Floor 12'), 12);
  assert.strictEqual(floorOf('Vale Crossing'), null);
  assert.strictEqual(floorOf('Spire of Trials: Floor x'), null);
});

test('a character who never entered: floor 0, first boss is next', () => {
  assert.deepStrictEqual(spireFromRows(tower(61)), { highestFloor: 0, maxFloor: 61, nextBossFloor: 5 });
});

test('highest floor is the highest ever seen, even with gaps', () => {
  const rows = tower(61).map((r) => ({ ...r, seen: [1, 2, 3, 7, 12].includes(Number(r.name.split(' ').pop())) }));
  assert.strictEqual(spireFromRows(rows).highestFloor, 12);
});

test('the next boss is the lowest gate boss not yet beaten', () => {
  const rows = tower(61).map((r) => ({ ...r, cleared: ['5', '10'].includes(r.name.split(' ').pop()) }));
  assert.strictEqual(spireFromRows(rows).nextBossFloor, 15);
});

test('every gate boss beaten: no next boss', () => {
  const rows = tower(61).map((r) => ({ ...r, cleared: r.boss }));
  assert.strictEqual(spireFromRows(rows).nextBossFloor, null);
});

test('no Spire in the database: all zeros, no crash', () => {
  assert.deepStrictEqual(spireFromRows([]), { highestFloor: 0, maxFloor: 0, nextBossFloor: null });
  assert.deepStrictEqual(spireFromRows(undefined), { highestFloor: 0, maxFloor: 0, nextBossFloor: null });
});
