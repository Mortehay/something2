const test = require('node:test');
const assert = require('node:assert');
const { CREATURE_BEHAVIORS } = require('../seeds/data/creatureBehaviors.js');
const { CREATURE_ABILITIES } = require('../seeds/data/creatureAbilities.js');
const { BEHAVIORS: MIGRATION_BEHAVIORS } = require('../migrations/1714440080000_creature_behaviors.js');
const { DEFAULT_BEHAVIOR, DEFAULT_ABILITY, resolveBehavior } = require('../src/services/creatureBehaviors.js');
const {
  AGGRO_RADIUS, LEASH_RADIUS, CONTACT_RANGE, CREATURE_ATTACK_COOLDOWN,
  GUARD_AGGRO_RADIUS, GUARD_LEASH_RADIUS, GUARD_DAMAGE,
} = require('../src/authority/creatures.js');
// Alias: the seed catalog under the name the Skittish tests below use.
const SEED_BEHAVIORS = CREATURE_BEHAVIORS;

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
});

// SOMET-279. This assertion is the INVERSE of the one that stood here until
// now ("Guard.damage_override must equal GUARD_DAMAGE"), and the inversion is
// the whole point: that assertion defended the bug.
//
// The tick computes every hit as `(bh.damageOverride ?? c.damage)`
// (authority/creatures.js). Village guards are level-scaled per instance --
// migration 1714440173000 wrote level/hp/damage/defense onto every live
// world_creatures row and villages.js writes them for new guards, so a guard
// in The Abyss: Hub carries damage 147.5. A non-null damage_override on the
// shared Guard behaviour SHADOWS all of it: every guard in every world hits
// for a flat 25, which applyDamage (`raw - defense`, floored at MIN_DAMAGE)
// turns into literally 1 against a level-50 hostile.
//
// The migration nulled the live column, but the seed file kept authoring 25
// and scripts/seed-catalogs.js writes what the seed file carries -- so a
// routine `npm run seed:catalogs` re-broke level scaling silently, and the
// old assertion here made the suite green while it did. GUARD_DAMAGE is not
// retired: it is still the level-1 BASE damage villages.js feeds to
// scaleCreature, and still the unprofiled-guard fallback in
// GUARD_DEFAULT_BEHAVIOR. It is simply no longer a catalog column.
test('the seeded Guard row does NOT carry a damage_override', () => {
  const guard = CREATURE_BEHAVIORS.find((b) => b.name === 'Guard');
  assert.ok(guard, 'Guard is missing from the seed catalog');

  assert.equal(guard.damage_override ?? null, null,
    'Guard.damage_override must be absent: `(bh.damageOverride ?? c.damage)` makes any value here '
    + 'shadow every level-scaled guard\'s per-instance world_creatures.damage, and seeding it back '
    + 'flattens every guard to a flat hit with no error');

  // No OTHER behaviour may quietly acquire one either. damage_override is a
  // legitimate column (an admin can set one through the behaviours API), but
  // nothing in the shipped catalog should carry one: the whole catalog is
  // per-instance-scaled now, so a seeded override is always a shadow.
  const withOverride = CREATURE_BEHAVIORS.filter((b) => (b.damage_override ?? null) !== null);
  assert.deepEqual(withOverride.map((b) => b.name), [],
    'a seeded damage_override shadows that rung\'s per-instance world_creatures.damage for every '
    + 'creature using it — if one is genuinely wanted, say so here deliberately');
});

// GUARD_DAMAGE keeps its meaning even though it is no longer a catalog
// column: villages.js feeds it to scaleCreature as the guard's LEVEL-1
// damage, so a level-1 guard must still hit for exactly what guards have
// always hit for. Migration 1714440080000's frozen array is the independent
// historical record of that number -- comparing against it (rather than
// re-typing 25) is what makes this a pin and not a restatement.
test('GUARD_DAMAGE still equals the damage guards historically hit for', () => {
  const row = MIGRATION_BEHAVIORS.find((r) => r[0] === 'Guard');
  assert.ok(row, 'Guard is missing from the migration array');
  const historical = row[MIGRATION_FIELD_ORDER.indexOf('damage_override')];
  assert.equal(historical, 25, 'fixture check: the frozen migration value');
  assert.equal(GUARD_DAMAGE, historical,
    'GUARD_DAMAGE is villages.js\'s level-1 base damage — drift here silently rebalances every '
    + 'guard in the game against the number they were built at');
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

// SOMET-279 introduced the FIRST deliberate divergence between the two
// copies, and it is exactly one cell: Guard.damage_override.
//
// 1714440080000 inserted Guard with 25 and is frozen history — a migration
// states what the database was set to on a date and must never be rewritten.
// 1714440173000 then SET that column to NULL, because a non-null override
// shadows every level-scaled guard's per-instance damage (see the Guard test
// above). The seed file is the live catalog, so it follows the LATER
// migration, not the earlier one.
//
// Enumerated as a map with the superseded value spelled out, and both sides
// asserted below, rather than skipped: the exception cannot silently widen to
// another row or another column, and it goes red if anyone "fixes" the
// history by editing 1714440080000.
const SUPERSEDED_BY_LATER_MIGRATION = new Map([
  ['Guard.damage_override', { migration: 25, seed: null, by: '1714440173000' }],
]);

test('the seed catalog and the migration\'s BEHAVIORS array cannot diverge, field for field', () => {
  assert.ok(MIGRATION_BEHAVIORS.length > 0, 'no migration rows — this test would assert nothing');
  const seedByName = new Map(CREATURE_BEHAVIORS.map((b) => [b.name, b]));
  const exceptionsSeen = new Set();

  for (const row of MIGRATION_BEHAVIORS) {
    const [name] = row;
    const seedRow = seedByName.get(name);
    assert.ok(seedRow, `migration row ${name} has no counterpart in the seed file`);
    MIGRATION_FIELD_ORDER.forEach((field, i) => {
      const migrationValue = row[i] === null ? null : row[i];
      const seedValue = field === 'damage_override' ? (seedRow[field] ?? null) : seedRow[field];

      const exception = SUPERSEDED_BY_LATER_MIGRATION.get(`${name}.${field}`);
      if (exception) {
        exceptionsSeen.add(`${name}.${field}`);
        assert.equal(migrationValue, exception.migration,
          `${name}.${field}: the frozen migration value changed — history was rewritten`);
        assert.equal(seedValue, exception.seed,
          `${name}.${field}: the seed file must carry ${exception.seed}, superseded by migration `
          + `${exception.by}; re-authoring the old value re-breaks it on the next seed run`);
        return;
      }

      assert.equal(seedValue, migrationValue,
        `${name}.${field}: seed=${seedValue} migration=${migrationValue}`);
    });
  }

  // A stale exception is as bad as a missing one: it would exempt a cell that
  // no longer needs exempting, hiding a real divergence there forever.
  assert.deepEqual([...exceptionsSeen].sort(), [...SUPERSEDED_BY_LATER_MIGRATION.keys()].sort(),
    'every declared exception must correspond to a real migration cell');
});

test('the Skittish profile is in the catalog and resolves to its own style', () => {
  const skittish = SEED_BEHAVIORS.find((b) => b.name === 'Skittish');
  assert.ok(skittish, 'no Skittish row in the seed catalog');
  assert.equal(skittish.chase_style, 'skittish');
  // The flee radius. Asserted as a real number rather than "is defined":
  // preferred_range IS the flee radius for this style, so a 0 here would mean
  // a creature that never backs away and the behaviour would be inert.
  assert.ok(skittish.preferred_range > 0,
    'preferred_range is the flee radius — a zero makes the behaviour inert');
  assert.ok(skittish.aggro_radius > skittish.preferred_range,
    'a skittish creature must notice you before you are close enough to scare it');
});

test('resolveBehavior accepts skittish rather than falling back to Line', () => {
  const bh = resolveBehavior({
    // behavior_name, not name: resolveBehavior reads the join-aliased column
    // (see its own header comment), and every other fixture in this suite
    // uses behavior_name for the same reason -- a bare `name` key here would
    // silently resolve to DEFAULT_BEHAVIOR.name ('Line') regardless of the
    // chase_style fix, and this assertion is what would have gone red.
    behavior_name: 'Skittish', chase_style: 'skittish', aggro_radius: 300,
    leash_radius: 500, preferred_range: 150, move_speed_mult: 1.1,
  });
  assert.equal(bh.chaseStyle, 'skittish');
  assert.equal(bh.name, 'Skittish');
  // The fallback is what this guards against: an unrecognised chase_style
  // resolves to DEFAULT_BEHAVIOR (Line, chaseStyle 'charge'), which would make
  // every skittish creature a normal aggressive one with nothing failing.
  assert.notEqual(bh.chaseStyle, 'charge');
});
