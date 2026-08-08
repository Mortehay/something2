const test = require('node:test');
const assert = require('node:assert');
const { CREATURE_BEHAVIORS } = require('../seeds/data/creatureBehaviors.js');
const { CREATURE_ABILITIES } = require('../seeds/data/creatureAbilities.js');
const { BEHAVIORS: MIGRATION_BEHAVIORS } = require('../migrations/1714440080000_creature_behaviors.js');
const { DEFAULT_BEHAVIOR, DEFAULT_ABILITY } = require('../src/services/creatureBehaviors.js');
const {
  AGGRO_RADIUS, LEASH_RADIUS, CONTACT_RANGE, CREATURE_ATTACK_COOLDOWN,
  GUARD_AGGRO_RADIUS, GUARD_LEASH_RADIUS, GUARD_DAMAGE,
} = require('../src/authority/creatures.js');

// SOMET-249 fix-wave I1.
//
// The golden trace (creature_behavior_golden.test.js) proves the in-JS
// DEFAULT_BEHAVIOR fallback is behaviour-neutral -- but its four fixtures
// carry NO behaviour at all, so they never touch a real database row. The
// running game reads the database `Line` row (every existing creature type
// is backfilled to it by the migration). Nothing before this test pinned
// THAT row to the constants it is documented to equal -- change
// Line.attack_range from 60 to 600 in the seed file and the whole suite,
// golden test included, stayed green.
//
// This is the one place in the codebase where comparing seed data against
// the authority/creatures.js constants is CORRECT rather than circular: the
// whole point of these two exports existing side by side is that they must
// not drift, and this test is what enforces it.
test('the database Line row equals DEFAULT_BEHAVIOR and today\'s hostile constants', () => {
  const line = CREATURE_BEHAVIORS.find((b) => b.name === 'Line');
  assert.ok(line, 'Line is missing from the seed catalog');

  // Against the in-JS fallback. SOMET-253 moved the five attack fields out of
  // DEFAULT_BEHAVIOR and into DEFAULT_ABILITY -- the equality this test exists
  // to enforce is unchanged, only the object holding the right-hand side is.
  assert.equal(line.attack_kind, DEFAULT_ABILITY.attackKind);
  assert.equal(line.attack_range, DEFAULT_ABILITY.attackRange);
  assert.equal(line.attack_cooldown, DEFAULT_ABILITY.attackCooldown);
  assert.equal(line.projectile_speed, DEFAULT_ABILITY.projectileSpeed);
  assert.equal(line.projectile_radius, DEFAULT_ABILITY.projectileRadius);
  assert.equal(line.aggro_radius, DEFAULT_BEHAVIOR.aggroRadius);
  assert.equal(line.leash_radius, DEFAULT_BEHAVIOR.leashRadius);
  assert.equal(line.chase_style, DEFAULT_BEHAVIOR.chaseStyle);
  assert.equal(line.preferred_range, DEFAULT_BEHAVIOR.preferredRange);
  assert.equal(line.move_speed_mult, DEFAULT_BEHAVIOR.moveSpeedMult);
  assert.equal(line.damage_override ?? null, DEFAULT_BEHAVIOR.damageOverride);

  // ...and against the now-dead-in-src constants the fallback is documented
  // to mirror (authority/creatures.js's header comment on DEFAULT_BEHAVIOR).
  assert.equal(line.attack_range, CONTACT_RANGE, 'Line.attack_range must equal CONTACT_RANGE');
  assert.equal(line.attack_cooldown, CREATURE_ATTACK_COOLDOWN, 'Line.attack_cooldown must equal CREATURE_ATTACK_COOLDOWN');
  assert.equal(line.aggro_radius, AGGRO_RADIUS, 'Line.aggro_radius must equal AGGRO_RADIUS');
  assert.equal(line.leash_radius, LEASH_RADIUS, 'Line.leash_radius must equal LEASH_RADIUS');
});

// SOMET-253 Task 2: the live read path is the ABILITY, not the behaviour row.
// The test above pins creature_behaviors.Line to the in-JS fallback, but from
// this task onward nothing in the tick reads those columns -- change
// creature_abilities' Line row from 60 to 600 and that test, the golden trace
// (whose fixtures carry no profile at all) and the whole suite stay green
// while every real Line creature reaches from ten tiles away. Same rationale,
// one table across.
test('the seeded Line ABILITY equals DEFAULT_ABILITY and today\'s hostile constants', () => {
  const line = CREATURE_ABILITIES.find((a) => a.behavior_name === 'Line' && a.slot === 1);
  assert.ok(line, 'Line slot 1 is missing from the ability seed catalog');

  assert.equal(line.attack_kind, DEFAULT_ABILITY.attackKind);
  assert.equal(line.attack_range, DEFAULT_ABILITY.attackRange);
  assert.equal(line.attack_cooldown, DEFAULT_ABILITY.attackCooldown);
  assert.equal(line.projectile_speed, DEFAULT_ABILITY.projectileSpeed);
  assert.equal(line.projectile_radius, DEFAULT_ABILITY.projectileRadius);
  assert.equal(line.damage_mult, DEFAULT_ABILITY.damageMult);
  assert.equal(line.knockback, DEFAULT_ABILITY.knockback);
  // NULL, not 'physical': the ability inherits the creature type's own
  // attack_element, which is what reproduces today's behaviour exactly.
  assert.strictEqual(line.element, null);

  assert.equal(line.attack_range, CONTACT_RANGE, 'Line ability range must equal CONTACT_RANGE');
  assert.equal(line.attack_cooldown, CREATURE_ATTACK_COOLDOWN,
    'Line ability cooldown must equal CREATURE_ATTACK_COOLDOWN');
});

// The Guard profile's slot-1 ability is what a guard's post-defence strike
// actually reads now; GUARD_DEFAULT_BEHAVIOR (the unprofiled-guard fallback)
// carries DEFAULT_ABILITY, so the two must agree or a profiled guard and an
// unprofiled one hit at different reaches and rates.
test('the seeded Guard ABILITY matches the unprofiled-guard fallback', () => {
  const guard = CREATURE_ABILITIES.find((a) => a.behavior_name === 'Guard' && a.slot === 1);
  assert.ok(guard, 'Guard slot 1 is missing from the ability seed catalog');
  assert.equal(guard.attack_kind, 'melee');
  assert.equal(guard.attack_range, 60);
  assert.equal(guard.attack_cooldown, 1.0);
  assert.equal(guard.damage_mult, 1);
});

test('the database Guard row equals today\'s GUARD_* constants', () => {
  const guard = CREATURE_BEHAVIORS.find((b) => b.name === 'Guard');
  assert.ok(guard, 'Guard is missing from the seed catalog');

  assert.equal(guard.chase_style, 'guard');
  assert.equal(guard.aggro_radius, GUARD_AGGRO_RADIUS, 'Guard.aggro_radius must equal GUARD_AGGRO_RADIUS');
  assert.equal(guard.leash_radius, GUARD_LEASH_RADIUS, 'Guard.leash_radius must equal GUARD_LEASH_RADIUS');
  // damage_override is the one column DEFAULT_BEHAVIOR-style comparisons
  // exempt everywhere else in this fix wave (0 is a real value, "hits for
  // nothing") -- but Guard's own value must still equal GUARD_DAMAGE, the
  // constant it exists to reproduce.
  assert.equal(guard.damage_override, GUARD_DAMAGE, 'Guard.damage_override must equal GUARD_DAMAGE');
});

// The migration inserts BEHAVIORS as positional arrays; the seed file carries
// the same data as named objects (seeds/data/creatureBehaviors.js's own
// comment says the seed file is a superset re-applied by `make
// seed-catalogs`). catalog_seed_data.test.js already pins the NAME superset;
// this pins every FIELD of every row the two copies share, so a hand-edit to
// one copy (e.g. rebalancing Sentry's attack_range in the seed file without
// touching the migration, or vice versa) cannot silently diverge the fresh-
// database behaviour from the re-seeded one.
const MIGRATION_FIELD_ORDER = [
  'name', 'attack_kind', 'attack_range', 'attack_cooldown', 'projectile_speed',
  'projectile_radius', 'aggro_radius', 'leash_radius', 'chase_style',
  'preferred_range', 'move_speed_mult', 'damage_override',
];

test('the seed catalog and the migration\'s BEHAVIORS array cannot diverge, field for field', () => {
  assert.ok(MIGRATION_BEHAVIORS.length > 0, 'no migration rows — this test would assert nothing');
  const seedByName = new Map(CREATURE_BEHAVIORS.map((b) => [b.name, b]));

  for (const row of MIGRATION_BEHAVIORS) {
    const [name] = row;
    const seedRow = seedByName.get(name);
    assert.ok(seedRow, `migration row ${name} has no counterpart in the seed file`);
    MIGRATION_FIELD_ORDER.forEach((field, i) => {
      const migrationValue = row[i] === null ? null : row[i];
      const seedValue = field === 'damage_override' ? (seedRow[field] ?? null) : seedRow[field];
      assert.equal(seedValue, migrationValue,
        `${name}.${field}: seed=${seedValue} migration=${migrationValue}`);
    });
  }
});
