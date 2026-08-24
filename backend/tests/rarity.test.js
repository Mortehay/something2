const test = require('node:test');
const assert = require('node:assert');
const { interpolateWeights, rollRarity, RARITIES } = require('../src/authority/rarity.js');

// The spec's own anchor table (design doc 6.3), written out BY HAND rather
// than imported from gameSettings.DEFAULTS -- a test that reads the same
// constant the code reads proves nothing about the interpolation.
const ANCHORS = [
  { item_level: 1, white: 90, blue: 9, yellow: 1, foxy: 0 },
  { item_level: 50, white: 70, blue: 21, yellow: 8, foxy: 1 },
  { item_level: 150, white: 45, blue: 30, yellow: 20, foxy: 5 },
];

test('RARITIES is the four grades in ascending order', () => {
  assert.deepStrictEqual(RARITIES, ['white', 'blue', 'yellow', 'foxy']);
});

test('an anchor level returns that anchor row, normalised to 1', () => {
  assert.deepStrictEqual(interpolateWeights(1, ANCHORS),
    { white: 0.9, blue: 0.09, yellow: 0.01, foxy: 0 });
  assert.deepStrictEqual(interpolateWeights(50, ANCHORS),
    { white: 0.7, blue: 0.21, yellow: 0.08, foxy: 0.01 });
  assert.deepStrictEqual(interpolateWeights(150, ANCHORS),
    { white: 0.45, blue: 0.3, yellow: 0.2, foxy: 0.05 });
});

test('a level between anchors interpolates linearly', () => {
  // Halfway between level 1 and level 50 is level 25.5; use it so the
  // fractions are exact: white = (90 + 70) / 2 = 80, blue = (9 + 21) / 2 = 15,
  // yellow = (1 + 8) / 2 = 4.5, foxy = (0 + 1) / 2 = 0.5, total 100.
  assert.deepStrictEqual(interpolateWeights(25.5, ANCHORS),
    { white: 0.8, blue: 0.15, yellow: 0.045, foxy: 0.005 });
  // And in the upper segment: halfway between 50 and 150 is 100.
  // white = (70 + 45) / 2 = 57.5, blue = (21 + 30) / 2 = 25.5,
  // yellow = (8 + 20) / 2 = 14, foxy = (1 + 5) / 2 = 3, total 100.
  assert.deepStrictEqual(interpolateWeights(100, ANCHORS),
    { white: 0.575, blue: 0.255, yellow: 0.14, foxy: 0.03 });
});

test('interpolation is monotonic between anchors', () => {
  // white only ever falls and foxy only ever rises across the whole table,
  // which is the property that makes "higher level -> better loot" true at
  // every level rather than only at the three authored ones.
  let prev = interpolateWeights(1, ANCHORS);
  for (let lvl = 2; lvl <= 150; lvl += 1) {
    const cur = interpolateWeights(lvl, ANCHORS);
    assert.ok(cur.white <= prev.white + 1e-12, `white rose at level ${lvl}`);
    assert.ok(cur.foxy >= prev.foxy - 1e-12, `foxy fell at level ${lvl}`);
    assert.ok(cur.yellow >= prev.yellow - 1e-12, `yellow fell at level ${lvl}`);
    const sum = cur.white + cur.blue + cur.yellow + cur.foxy;
    assert.ok(Math.abs(sum - 1) < 1e-12, `level ${lvl} sums to ${sum}`);
    prev = cur;
  }
});

test('levels outside the table clamp to the nearest anchor', () => {
  assert.deepStrictEqual(interpolateWeights(0, ANCHORS), interpolateWeights(1, ANCHORS));
  assert.deepStrictEqual(interpolateWeights(-40, ANCHORS), interpolateWeights(1, ANCHORS));
  assert.deepStrictEqual(interpolateWeights(9999, ANCHORS), interpolateWeights(150, ANCHORS));
});

test('anchors given out of order are sorted, not trusted', () => {
  const shuffled = [ANCHORS[2], ANCHORS[0], ANCHORS[1]];
  assert.deepStrictEqual(interpolateWeights(25.5, shuffled),
    { white: 0.8, blue: 0.15, yellow: 0.045, foxy: 0.005 });
});

test('weights that do not sum to 100 still produce a valid normalised distribution', () => {
  const odd = [{ item_level: 1, white: 2, blue: 1, yellow: 1, foxy: 0 }];   // sums to 4
  assert.deepStrictEqual(interpolateWeights(1, odd),
    { white: 0.5, blue: 0.25, yellow: 0.25, foxy: 0 });

  const huge = [{ item_level: 1, white: 300, blue: 300, yellow: 300, foxy: 300 }]; // sums to 1200
  assert.deepStrictEqual(interpolateWeights(1, huge),
    { white: 0.25, blue: 0.25, yellow: 0.25, foxy: 0.25 });

  // A table that sums to less than 100 must not leave the cumulative short --
  // that is the exact failure normalisation exists to prevent.
  const small = [{ item_level: 1, white: 5, blue: 3, yellow: 1, foxy: 1 }];  // sums to 10
  assert.deepStrictEqual(interpolateWeights(1, small),
    { white: 0.5, blue: 0.3, yellow: 0.1, foxy: 0.1 });
});

test('a broken or empty table falls back to all-white rather than dividing by zero', () => {
  assert.deepStrictEqual(interpolateWeights(50, []), { white: 1, blue: 0, yellow: 0, foxy: 0 });
  assert.deepStrictEqual(interpolateWeights(50, null), { white: 1, blue: 0, yellow: 0, foxy: 0 });
  assert.deepStrictEqual(
    interpolateWeights(50, [{ item_level: 1, white: 0, blue: 0, yellow: 0, foxy: 0 }]),
    { white: 1, blue: 0, yellow: 0, foxy: 0 },
  );
  assert.deepStrictEqual(
    interpolateWeights(50, [{ item_level: 1, white: -5, blue: -5, yellow: -5, foxy: -5 }]),
    { white: 1, blue: 0, yellow: 0, foxy: 0 },
  );
  // A row missing three grades entirely is not malformed enough to discard:
  // the one grade it does name takes the whole distribution.
  assert.deepStrictEqual(interpolateWeights(50, [{ item_level: 1, blue: 7 }]),
    { white: 0, blue: 1, yellow: 0, foxy: 0 });
});

test('rollRarity walks the cumulative distribution in grade order', () => {
  const odd = [{ item_level: 1, white: 2, blue: 1, yellow: 1, foxy: 0 }]; // 0.5 / 0.25 / 0.25 / 0
  assert.strictEqual(rollRarity(1, odd, () => 0), 'white');
  assert.strictEqual(rollRarity(1, odd, () => 0.4), 'white');
  assert.strictEqual(rollRarity(1, odd, () => 0.6), 'blue');
  assert.strictEqual(rollRarity(1, odd, () => 0.8), 'yellow');
  // foxy has weight 0 and must be unreachable even at the very top of the range
  assert.strictEqual(rollRarity(1, odd, () => 0.999999), 'yellow');
});

test('a zero-weight leading grade is skipped, not returned', () => {
  const foxyOnly = [{ item_level: 1, white: 0, blue: 0, yellow: 0, foxy: 1 }];
  assert.strictEqual(rollRarity(1, foxyOnly, () => 0), 'foxy');
  assert.strictEqual(rollRarity(1, foxyOnly, () => 0.9999), 'foxy');
});

test('a level-1 creature can NEVER drop foxy', () => {
  // Criterion 4. foxy's level-1 anchor weight is 0, so no rng value at all --
  // including one that lands exactly on the top of the cumulative -- may
  // return it.
  for (let i = 0; i <= 1000; i += 1) {
    assert.notStrictEqual(rollRarity(1, ANCHORS, () => i / 1000), 'foxy');
  }
  assert.notStrictEqual(rollRarity(1, ANCHORS, () => 1 - Number.EPSILON), 'foxy');
});

test('a level-150 creature still drops white most of the time', () => {
  // Criterion 4's other half: the top of the table is 45% white, so a
  // uniform sweep must land on white for strictly more than a third of the
  // rolls and strictly fewer than half.
  let whites = 0;
  const N = 10000;
  for (let i = 0; i < N; i += 1) if (rollRarity(150, ANCHORS, () => i / N) === 'white') whites += 1;
  assert.ok(whites / N > 0.44 && whites / N < 0.46, `white share was ${whites / N}`);
});

test('rollRarity is monotonic in rng -- a higher roll never yields a worse grade', () => {
  const seen = [];
  for (let i = 0; i <= 100; i += 1) seen.push(rollRarity(150, ANCHORS, () => i / 100));
  for (let i = 1; i < seen.length; i += 1) {
    assert.ok(RARITIES.indexOf(seen[i]) >= RARITIES.indexOf(seen[i - 1]),
      `roll ${i / 100} gave ${seen[i]} after ${seen[i - 1]}`);
  }
  assert.strictEqual(seen[0], 'white');
  assert.strictEqual(seen[seen.length - 1], 'foxy');
});

test('hand-computed boundaries at level 150: 0.45 / 0.75 / 0.95', () => {
  // Cumulative for the level-150 anchor, worked out by hand from the table
  // above: white ends at 0.45, blue at 0.45+0.30 = 0.75, yellow at
  // 0.75+0.20 = 0.95, foxy takes the remaining 0.05. Each pair below straddles
  // one of those three edges.
  assert.strictEqual(rollRarity(150, ANCHORS, () => 0.44), 'white');
  assert.strictEqual(rollRarity(150, ANCHORS, () => 0.46), 'blue');
  assert.strictEqual(rollRarity(150, ANCHORS, () => 0.74), 'blue');
  assert.strictEqual(rollRarity(150, ANCHORS, () => 0.76), 'yellow');
  assert.strictEqual(rollRarity(150, ANCHORS, () => 0.94), 'yellow');
  assert.strictEqual(rollRarity(150, ANCHORS, () => 0.96), 'foxy');
});
