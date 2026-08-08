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

// SOMET-254: damage_override had no type check at all -- a non-numeric value
// used to sail through behaviorFieldError and reach Postgres as a real-column
// cast error (a raw 500) instead of a 400 naming the field.
test('rejects a non-numeric damage_override', () => {
  assert.match(behaviorFieldError({ ...VALID, damage_override: 'lots' }), /damage_override/);
});

test('accepts a negative damage_override (a healing profile)', () => {
  assert.equal(behaviorFieldError({ ...VALID, damage_override: -5 }), null);
});

// SOMET-253 Task 8: pack-leader aura + per-rung gold. VALID carries none of
// these six fields at all (like most seeded profiles), so a fully-formed
// profile with them entirely absent must still pass -- they are optional,
// falling back to the column defaults (0/1/1/1/0/0) exactly like
// preferred_range/damage_override already do.
test('a profile with no aura/gold fields at all still passes (falls back to column defaults)', () => {
  assert.equal(behaviorFieldError(VALID), null);
});

// aura_radius 0 means "not a leader" -- the correct value for eleven of the
// twelve seeded profiles, not an unset field. Only negative is rejected.
test('accepts aura_radius of 0', () => {
  assert.equal(behaviorFieldError({ ...VALID, aura_radius: 0 }), null);
});

test('rejects a negative aura_radius', () => {
  assert.match(behaviorFieldError({ ...VALID, aura_radius: -1 }), /aura_radius/);
});

// The three aura multipliers are a different kind of 0 than aura_radius: an
// aura_damage_mult/aura_defense_mult/aura_speed_mult of 0 makes every
// creature the aura touches deal, take, or move at NOTHING the instant a
// leader stands near them -- silently, the same class of bug SOMET-249's
// fix-wave I4 closed for move_speed_mult. Strictly > 0.
for (const field of ['aura_damage_mult', 'aura_defense_mult', 'aura_speed_mult']) {
  test(`rejects ${field} of exactly 0 when present`, () => {
    const err = behaviorFieldError({ ...VALID, [field]: 0 });
    assert.match(err, new RegExp(field), `error should name ${field}, got: ${err}`);
  });

  test(`rejects a negative ${field}`, () => {
    const err = behaviorFieldError({ ...VALID, [field]: -1 });
    assert.match(err, new RegExp(field));
  });

  test(`accepts a small positive ${field}`, () => {
    assert.equal(behaviorFieldError({ ...VALID, [field]: 0.5 }), null);
  });
}

test('accepts gold_min of 0', () => {
  assert.equal(behaviorFieldError({ ...VALID, gold_min: 0, gold_max: 5 }), null);
});

test('rejects a negative gold_min', () => {
  assert.match(behaviorFieldError({ ...VALID, gold_min: -1 }), /gold_min/);
});

// Mirrors migration 1714440085000's `CHECK (gold_min >= 0 AND gold_max >=
// gold_min)`.
test('rejects gold_max below gold_min', () => {
  assert.match(behaviorFieldError({ ...VALID, gold_min: 5, gold_max: 2 }), /gold_max/);
});

test('accepts gold_max equal to gold_min', () => {
  assert.equal(behaviorFieldError({ ...VALID, gold_min: 5, gold_max: 5 }), null);
});

test('rejects a gold_max below the default gold_min of 0 when gold_min is omitted', () => {
  assert.match(behaviorFieldError({ ...VALID, gold_max: -1 }), /gold_max/);
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
