// Pure unit tests for behaviorFieldError, the /api/creature-behaviors
// POST/PUT validator in src/index.js. No database, no HTTP -- the function
// runs entirely before any pool.query call, same rationale as
// item_types_api.test.js's validateItemType tests.
//
// SOMET-253 Task 3 moved every attack-related field off the behaviour and
// onto the nested `abilities` array: behaviorFieldError now covers only
// name/chase_style/aggro_radius/leash_radius/move_speed_mult/
// preferred_range/damage_override. abilityFieldError and
// behaviorAbilitiesError (the two-table-spanning rules -- guard-must-be-melee,
// kite-preferred-range) are covered end to end, against a real database, by
// creature_abilities_api_db.test.js instead of here.
const test = require('node:test');
const assert = require('node:assert');
const { behaviorFieldError } = require('../src/index.js');
const { CREATURE_BEHAVIORS } = require('../seeds/data/creatureBehaviors.js');

const VALID = {
  name: 'zzValid',
  aggro_radius: 400,
  leash_radius: 800,
  chase_style: 'charge',
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
// aggroes, and never chases one past its own feet. These three must be
// strictly > 0.
for (const field of ['aggro_radius', 'leash_radius', 'move_speed_mult']) {
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

// preferred_range is legitimately 0 (no standoff distance for a melee
// profile) -- only negative is rejected.
test('accepts preferred_range of 0', () => {
  assert.equal(behaviorFieldError({ ...VALID, preferred_range: 0 }), null);
});

test('rejects a negative preferred_range', () => {
  assert.match(behaviorFieldError({ ...VALID, preferred_range: -1 }), /preferred_range/);
});

test('rejects an unknown chase_style', () => {
  assert.match(behaviorFieldError({ ...VALID, chase_style: 'teleport' }), /chase_style/);
});

test('rejects a missing name', () => {
  assert.match(behaviorFieldError({ ...VALID, name: '' }), /name/);
});

// damage_override is exempt from the positive-only rule: 0 is a real value
// meaning "hits for nothing" (the Guard profile's own damage_override is a
// real, deliberate number, but a 0 override is equally legitimate).
test('damage_override of 0 is accepted, not rejected as a zero numeric', () => {
  assert.equal(behaviorFieldError({ ...VALID, damage_override: 0 }), null);
});

// Every seeded profile is real production data. behaviorFieldError no longer
// looks at the attack fields these rows still carry (they exist only to keep
// creature_behaviors_invariants.test.js's field-for-field pin against the
// historical migration array), so this loop confirms the movement half of
// each profile is still valid on its own.
for (const b of CREATURE_BEHAVIORS) {
  test(`seeded profile "${b.name}" still passes behaviorFieldError`, () => {
    assert.equal(behaviorFieldError(b), null, `${b.name} unexpectedly rejected`);
  });
}
