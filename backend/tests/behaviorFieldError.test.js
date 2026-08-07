// Pure unit tests for behaviorFieldError, the /api/creature-behaviors
// POST/PUT validator in src/index.js. No database, no HTTP -- the function
// runs entirely before any pool.query call, same rationale as
// item_types_api.test.js's validateItemType tests.
const test = require('node:test');
const assert = require('node:assert');
const { behaviorFieldError } = require('../src/index.js');
const { CREATURE_BEHAVIORS } = require('../seeds/data/creatureBehaviors.js');

const VALID = {
  name: 'zzValid',
  attack_kind: 'melee',
  attack_range: 60,
  attack_cooldown: 1,
  aggro_radius: 400,
  leash_radius: 800,
  chase_style: 'charge',
  projectile_speed: 0,
  projectile_radius: 0,
  preferred_range: 0,
  move_speed_mult: 1,
  damage_override: null,
};

test('a fully-formed profile passes', () => {
  assert.equal(behaviorFieldError(VALID), null);
});

// SOMET-249 fix-wave I4: the "Add Behavior" modal used to open with every
// numeric at 0. A saved 0 there is not damage_override's kind of real value
// ("hits for nothing") -- it produces a creature that never moves, never
// aggroes, and never attacks. These five must be strictly > 0.
for (const field of ['attack_range', 'attack_cooldown', 'aggro_radius', 'leash_radius', 'move_speed_mult']) {
  test(`rejects ${field} of exactly 0`, () => {
    const err = behaviorFieldError({ ...VALID, [field]: 0 });
    assert.match(err, new RegExp(field), `error should name ${field}, got: ${err}`);
  });

  test(`rejects a negative ${field}`, () => {
    const err = behaviorFieldError({ ...VALID, [field]: -5 });
    assert.match(err, new RegExp(field));
  });

  test(`accepts a small positive ${field}`, () => {
    assert.equal(behaviorFieldError({ ...VALID, [field]: 0.5 }), null);
  });
}

// projectile_radius and preferred_range are legitimately 0 (no projectile, no
// standoff distance for a melee profile) -- only negative is rejected.
test('accepts projectile_radius of 0', () => {
  assert.equal(behaviorFieldError({ ...VALID, projectile_radius: 0 }), null);
});

test('rejects a negative projectile_radius', () => {
  assert.match(behaviorFieldError({ ...VALID, projectile_radius: -1 }), /projectile_radius/);
});

test('accepts preferred_range of 0', () => {
  assert.equal(behaviorFieldError({ ...VALID, preferred_range: 0 }), null);
});

test('rejects a negative preferred_range', () => {
  assert.match(behaviorFieldError({ ...VALID, preferred_range: -1 }), /preferred_range/);
});

// A kiter whose preferred standoff is farther out than its own attack_range
// can never close to a range where its own attack gate is satisfied -- it
// backs toward preferred_range, which is already unreachable, forever.
test('rejects a kite profile whose preferred_range exceeds attack_range', () => {
  const err = behaviorFieldError({
    ...VALID, attack_kind: 'ranged', chase_style: 'kite',
    projectile_speed: 400, attack_range: 300, preferred_range: 340,
  });
  assert.match(err, /kite/);
  assert.match(err, /preferred_range/);
});

test('accepts a kite profile whose preferred_range equals attack_range (boundary)', () => {
  const err = behaviorFieldError({
    ...VALID, attack_kind: 'ranged', chase_style: 'kite',
    projectile_speed: 400, attack_range: 300, preferred_range: 300,
  });
  assert.equal(err, null);
});

test('a non-kite chase_style is unaffected by preferred_range exceeding attack_range', () => {
  // 'charge' never uses preferred_range to hold a standoff distance, so the
  // oscillation failure mode this check exists for cannot occur -- the
  // constraint is deliberately kite-only.
  const err = behaviorFieldError({ ...VALID, chase_style: 'charge', attack_range: 60, preferred_range: 9999 });
  assert.equal(err, null);
});

// damage_override is exempt from the positive-only rule: 0 is a real value
// meaning "hits for nothing" (the Guard profile's own damage_override is a
// real, deliberate number, but a 0 override is equally legitimate).
test('damage_override of 0 is accepted, not rejected as a zero numeric', () => {
  assert.equal(behaviorFieldError({ ...VALID, damage_override: 0 }), null);
});

// Every seeded profile is real production data -- Task 4's carried
// validations (projectile_speed on ranged/cast, guard/melee) were already
// checked against these; this fix wave adds five more constraints, so
// re-verify the full catalog rather than assuming the new rules are
// compatible. Named per-profile so a future regression on a SPECIFIC row
// (not just "the catalog") is readable from the test name.
for (const b of CREATURE_BEHAVIORS) {
  test(`seeded profile "${b.name}" still passes behaviorFieldError after the I4 tightening`, () => {
    assert.equal(behaviorFieldError(b), null, `${b.name} unexpectedly rejected`);
  });
}
