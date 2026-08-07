const test = require('node:test');
const assert = require('node:assert');
const {
  resolveBehavior, DEFAULT_BEHAVIOR, ATTACK_KINDS, CHASE_STYLES,
} = require('../src/services/creatureBehaviors.js');

test('a null row resolves to the Line fallback', () => {
  const b = resolveBehavior(null);
  // Literals: comparing against DEFAULT_BEHAVIOR would compare the code to
  // itself and pass for any value at all.
  assert.equal(b.attackKind, 'melee');
  assert.equal(b.attackRange, 60);
  assert.equal(b.attackCooldown, 1);
  assert.equal(b.aggroRadius, 400);
  assert.equal(b.leashRadius, 800);
  assert.equal(b.chaseStyle, 'charge');
  assert.equal(b.moveSpeedMult, 1);
  assert.equal(b.damageOverride, null);
});

test('a complete row is carried through verbatim', () => {
  const b = resolveBehavior({
    behavior_name: 'Ranged', attack_kind: 'ranged', attack_range: 340,
    attack_cooldown: 1.8, projectile_speed: 520, projectile_radius: 6,
    aggro_radius: 460, leash_radius: 800, chase_style: 'kite',
    preferred_range: 240, move_speed_mult: 1, damage_override: null,
  });
  assert.equal(b.name, 'Ranged');
  assert.equal(b.attackKind, 'ranged');
  assert.equal(b.attackRange, 340);
  assert.equal(b.projectileSpeed, 520);
  assert.equal(b.preferredRange, 240);
  assert.equal(b.chaseStyle, 'kite');
});

test('an unknown attack_kind or chase_style falls back rather than reaching the sim', () => {
  const b = resolveBehavior({
    behavior_name: 'Broken', attack_kind: 'psychic', chase_style: 'teleport',
    attack_range: 60, attack_cooldown: 1, aggro_radius: 400, leash_radius: 800,
  });
  assert.equal(b.attackKind, 'melee', 'unknown kind must fall back');
  assert.equal(b.chaseStyle, 'charge', 'unknown style must fall back');
});

test('non-finite numbers fall back instead of poisoning the tick', () => {
  const b = resolveBehavior({
    behavior_name: 'Bad', attack_kind: 'melee', chase_style: 'charge',
    attack_range: NaN, attack_cooldown: null, aggro_radius: 'abc',
    leash_radius: undefined, move_speed_mult: Infinity,
  });
  assert.equal(b.attackRange, 60);
  assert.equal(b.attackCooldown, 1);
  assert.equal(b.aggroRadius, 400);
  assert.equal(b.leashRadius, 800);
  assert.equal(b.moveSpeedMult, 1);
});

test('damage_override of 0 is preserved, not treated as absent', () => {
  const b = resolveBehavior({
    behavior_name: 'Pacifist', attack_kind: 'melee', chase_style: 'charge',
    attack_range: 60, attack_cooldown: 1, aggro_radius: 400, leash_radius: 800,
    damage_override: 0,
  });
  assert.equal(b.damageOverride, 0);
});

test('DEFAULT_BEHAVIOR is frozen so a caller cannot mutate every creature at once', () => {
  assert.ok(Object.isFrozen(DEFAULT_BEHAVIOR));
});

test('the value sets match the database CHECK constraints', () => {
  assert.deepEqual(ATTACK_KINDS, ['melee', 'ranged', 'cast']);
  assert.deepEqual(CHASE_STYLES, ['charge', 'kite', 'skirmish', 'hold', 'ambush', 'guard']);
});
