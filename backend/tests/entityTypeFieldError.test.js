// Pure unit tests for entityTypeFieldError, the /api/entity-types POST/PUT
// validator in src/index.js. No database, no HTTP -- the function runs
// entirely before any pool.query call, same rationale as
// behaviorFieldError.test.js.
//
// SOMET-338: the display-size bound. These cases are written from the real
// table, not invented: a scan of all 304 rows found exactly two out of range
// (`Tree` at 777x888 and `Village Guard` at 0x0) and ~296 with NULL
// dimensions, which is every creature type plus Player. That distribution is
// why null must pass and why the ceiling sits far above the largest real
// value (pine_tree's 104).
const test = require('node:test');
const assert = require('node:assert');
const { entityTypeFieldError } = require('../src/index.js');

const VALID = { name: 'zzValid', color: '#123456' };

test('a body with no display fields at all passes', () => {
  assert.equal(entityTypeFieldError(VALID), null);
});

// The NULL majority: ~296 rows carry no display size and fall back to the
// renderer's default. An explicit null (what the admin form submits when the
// input is cleared) must be as acceptable as an absent key -- a bound that
// rejected it would make almost every creature row unsaveable.
for (const field of ['display_width', 'display_height']) {
  test(`accepts an explicitly null ${field}`, () => {
    assert.equal(entityTypeFieldError({ ...VALID, [field]: null }), null);
  });

  test(`rejects a ${field} above the ceiling`, () => {
    const err = entityTypeFieldError({ ...VALID, [field]: 777 });
    assert.match(err, new RegExp(field), `error should name ${field}, got: ${err}`);
  });

  // 0 is currently harmless only by accident -- drawEntity reads
  // `e.displayWidth || e.width || 40`, so 0 is falsy and silently degrades to
  // the 40px fallback. It is still junk data and the bound rejects it.
  test(`rejects a ${field} of exactly 0`, () => {
    assert.match(entityTypeFieldError({ ...VALID, [field]: 0 }), new RegExp(field));
  });

  test(`rejects a negative ${field}`, () => {
    assert.match(entityTypeFieldError({ ...VALID, [field]: -10 }), new RegExp(field));
  });

  test(`rejects a non-integer ${field}`, () => {
    assert.match(entityTypeFieldError({ ...VALID, [field]: 64.5 }), new RegExp(field));
  });

  // A string reaches Postgres as an integer-column cast error -- a raw 500
  // instead of a 400 naming the field, the same class of gap SOMET-254 closed
  // for damage_override.
  test(`rejects a non-numeric ${field}`, () => {
    assert.match(entityTypeFieldError({ ...VALID, [field]: '64' }), new RegExp(field));
  });

  test(`accepts a ${field} of exactly 1 and exactly 400 (the bounds)`, () => {
    assert.equal(entityTypeFieldError({ ...VALID, [field]: 1 }), null);
    assert.equal(entityTypeFieldError({ ...VALID, [field]: 400 }), null);
  });

  test(`rejects a ${field} of 401 (just past the ceiling)`, () => {
    assert.match(entityTypeFieldError({ ...VALID, [field]: 401 }), new RegExp(field));
  });
}

// The exact rows the scan flagged, and the exact value chosen to replace the
// Tree row. If the ceiling is ever retuned, these are the cases that say what
// it has to keep doing.
test('rejects the Tree row as it shipped (777x888)', () => {
  const err = entityTypeFieldError({ ...VALID, display_width: 777, display_height: 888 });
  assert.match(err, /display_width/);
});

test('rejects the Village Guard row as it stands (0x0)', () => {
  const err = entityTypeFieldError({ ...VALID, display_width: 0, display_height: 0 });
  assert.match(err, /display_width/);
});

test('accepts the corrected Tree size (80x130) and every other real row', () => {
  // Real values from entity_types: the corrected Tree, plus its siblings.
  const real = [[80, 130], [64, 104], [56, 92], [48, 48], [40, 40], [40, 44]];
  for (const [w, h] of real) {
    assert.equal(
      entityTypeFieldError({ ...VALID, display_width: w, display_height: h }),
      null,
      `${w}x${h} unexpectedly rejected`,
    );
  }
});

// The bound must not swallow the checks that were already there.
test('still rejects a bad attack_element alongside valid display fields', () => {
  const err = entityTypeFieldError({ ...VALID, display_width: 64, attack_element: 'plasma' });
  assert.match(err, /attack_element/);
});

test('still rejects a non-integer behavior_id alongside valid display fields', () => {
  const err = entityTypeFieldError({ ...VALID, display_height: 64, behavior_id: 'two' });
  assert.match(err, /behavior_id/);
});
