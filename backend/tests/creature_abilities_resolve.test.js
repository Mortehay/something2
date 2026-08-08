// Pure resolver tests for the abilities half of services/creatureBehaviors.js
// (SOMET-253 Task 2). No database, no clock -- same contract as
// creature_behaviors_resolve.test.js, which covers the movement half.
const test = require('node:test');
const assert = require('node:assert');
const {
  resolveBehavior, DEFAULT_BEHAVIOR, DEFAULT_ABILITY, ELEMENTS,
} = require('../src/services/creatureBehaviors.js');

test('a row with no abilities resolves to the default single ability', () => {
  const b = resolveBehavior({ behavior_name: 'Line', chase_style: 'charge' });
  assert.equal(b.abilities.length, 1);
  // Literals, not DEFAULT_ABILITY: comparing the resolver against the constant
  // it reads would pass for any value at all.
  assert.equal(b.abilities[0].attackKind, 'melee');
  assert.equal(b.abilities[0].attackRange, 60);
  assert.equal(b.abilities[0].attackCooldown, 1);
  assert.equal(b.abilities[0].slot, 1);
});

test('DEFAULT_BEHAVIOR carries exactly one ability, and no flat attack fields', () => {
  assert.equal(DEFAULT_BEHAVIOR.abilities.length, 1);
  assert.equal(DEFAULT_BEHAVIOR.abilities[0].attackRange, 60);
  // Task 2 removed the flat copies deliberately: two sources of truth for the
  // primary attack is the asymmetry this refactor exists to remove, and a
  // leftover `attackRange` here would be silently read by nothing while
  // looking authoritative.
  for (const dead of ['attackKind', 'attackRange', 'attackCooldown',
                      'projectileSpeed', 'projectileRadius']) {
    assert.ok(!(dead in DEFAULT_BEHAVIOR),
      `DEFAULT_BEHAVIOR must not carry a flat ${dead} any more`);
  }
});

test('the parent row\'s own attack_* columns no longer reach the sim', () => {
  // Task 3 drops these columns. Until then they are still SELECTed, and a
  // resolver that quietly kept reading them would make the abilities table
  // decorative -- the exact inertness this sub-project exists to prevent.
  const b = resolveBehavior({
    behavior_name: 'zzStale', chase_style: 'charge',
    attack_kind: 'ranged', attack_range: 999, attack_cooldown: 9,
    projectile_speed: 777, projectile_radius: 12,
    abilities: [{ slot: 1, attack_kind: 'melee', attack_range: 60, attack_cooldown: 1 }],
  });
  assert.equal(b.abilities[0].attackKind, 'melee');
  assert.equal(b.abilities[0].attackRange, 60);
  assert.equal(b.abilities[0].projectileSpeed, 0);
});

test('abilities arrive in slot order regardless of array order', () => {
  const b = resolveBehavior({
    behavior_name: 'zzApex',
    chase_style: 'charge',
    abilities: [
      { slot: 2, attack_kind: 'melee', attack_range: 90, attack_cooldown: 1.2 },
      { slot: 1, attack_kind: 'cast', attack_range: 260, attack_cooldown: 2 },
    ],
  });
  assert.deepEqual(b.abilities.map((a) => a.slot), [1, 2]);
  assert.equal(b.abilities[0].attackKind, 'cast');
  assert.equal(b.abilities[1].attackKind, 'melee');
});

test('a NULL numeric column falls back to the documented default, not zero', () => {
  // Number(null) === 0 and Number.isFinite(0) is true, so a NULL cooldown
  // resolving to 0 gives UNBOUNDED rate of fire. This is the exact bug P2a
  // caught in review before the module was written.
  const b = resolveBehavior({
    behavior_name: 'zzBroken',
    chase_style: 'charge',
    abilities: [{ slot: 1, attack_kind: 'melee', attack_range: null, attack_cooldown: null }],
  });
  assert.equal(b.abilities[0].attackCooldown, 1);
  assert.equal(b.abilities[0].attackRange, 60);
});

test('damage_mult of 0 survives -- it is a pure status-rider ability', () => {
  const b = resolveBehavior({
    behavior_name: 'zzRider',
    chase_style: 'charge',
    abilities: [{ slot: 1, attack_kind: 'cast', attack_range: 200, attack_cooldown: 2, damage_mult: 0 }],
  });
  assert.equal(b.abilities[0].damageMult, 0);   // NOT 1 -- `||` would break this
});

test('knockback of 0 and a real knockback both survive', () => {
  const b = resolveBehavior({
    behavior_name: 'zzBrute',
    chase_style: 'charge',
    abilities: [
      { slot: 1, attack_kind: 'melee', attack_range: 70, attack_cooldown: 1.8, knockback: 140 },
      { slot: 2, attack_kind: 'melee', attack_range: 70, attack_cooldown: 1.8, knockback: 0 },
    ],
  });
  assert.equal(b.abilities[0].knockback, 140);
  assert.equal(b.abilities[1].knockback, 0);
});

test('a NULL element stays null -- it means "inherit the type\'s element", not physical', () => {
  // Hardcoding 'physical' here would silently strip a Caster's fire: every
  // backfilled slot-1 ability carries element NULL precisely so the creature
  // type's attack_element still decides.
  const b = resolveBehavior({
    behavior_name: 'zzCaster',
    chase_style: 'charge',
    abilities: [{ slot: 1, attack_kind: 'cast', attack_range: 300, attack_cooldown: 2.4, element: null }],
  });
  assert.strictEqual(b.abilities[0].element, null);
});

test('an unrecognised element resolves to null, and a real one is carried through', () => {
  const b = resolveBehavior({
    behavior_name: 'zzMixed',
    chase_style: 'charge',
    abilities: [
      { slot: 1, attack_kind: 'cast', attack_range: 300, attack_cooldown: 2, element: 'fire' },
      { slot: 2, attack_kind: 'cast', attack_range: 300, attack_cooldown: 2, element: 'psychic' },
    ],
  });
  assert.equal(b.abilities[0].element, 'fire');
  assert.strictEqual(b.abilities[1].element, null);
});

test('an unknown attack_kind falls back to melee rather than reaching the sim', () => {
  const b = resolveBehavior({
    behavior_name: 'zzWeird',
    chase_style: 'charge',
    abilities: [{ slot: 1, attack_kind: 'psychic', attack_range: 200, attack_cooldown: 2 }],
  });
  assert.equal(b.abilities[0].attackKind, 'melee');
});

test('a slot of 0 or a fractional slot is clamped to a usable integer', () => {
  // slot is priority order and the DB CHECK requires >= 1; a row written
  // before that constraint (or an API caller) must not sort ahead of slot 1
  // with a 0 or -1.
  const b = resolveBehavior({
    behavior_name: 'zzSlots',
    chase_style: 'charge',
    abilities: [
      { slot: 0, attack_kind: 'melee', attack_range: 60, attack_cooldown: 1 },
      { slot: 2.7, attack_kind: 'melee', attack_range: 60, attack_cooldown: 1 },
    ],
  });
  assert.deepEqual(b.abilities.map((a) => a.slot), [1, 2]);
});

test('an ability with no name gets a usable one', () => {
  const b = resolveBehavior({
    behavior_name: 'zzNameless',
    chase_style: 'charge',
    abilities: [{ slot: 1, name: '', attack_kind: 'melee', attack_range: 60, attack_cooldown: 1 }],
  });
  assert.equal(b.abilities[0].name, 'Attack');
});

test('a null row still gets its single default ability', () => {
  const b = resolveBehavior(null);
  assert.equal(b.abilities.length, 1);
  assert.equal(b.abilities[0].attackRange, 60);
});

test('DEFAULT_ABILITY is frozen, and so is DEFAULT_BEHAVIOR\'s array', () => {
  // DEFAULT_BEHAVIOR is spread, not deep-cloned, so every fallback creature in
  // the process shares this one array by reference.
  assert.ok(Object.isFrozen(DEFAULT_ABILITY));
  assert.ok(Object.isFrozen(DEFAULT_BEHAVIOR.abilities));
});

test('the element set matches the database CHECK constraint', () => {
  assert.deepEqual(ELEMENTS, ['physical', 'fire', 'ice', 'lightning']);
});
