// SOMET-279 — running the catalog seeder must not flatten a level-scaled guard.
//
// The ticket had two halves. The first (migration 1714440173000 +
// villages.js) writes per-instance level/hp/damage/defense onto every village
// guard and is covered by village_guard_level_scaling*.test.js. The second is
// DURABILITY, and it is what this file exists for.
//
// The tick computes a hit as `(bh.damageOverride ?? c.damage)`
// (authority/creatures.js). The seeded 'Guard' behaviour used to carry
// damage_override = 25, which shadows world_creatures.damage for EVERY guard
// in EVERY world -- the migration worked around it by nulling the live
// column, but seeds/data/creatureBehaviors.js kept authoring 25 and
// scripts/seed-catalogs.js wrote it on both INSERT and UPDATE. So a routine
// `npm run seed:catalogs` put a level-50 guard back on a flat 25 damage, i.e.
// on the applyDamage floor of 1 against a level-50 hostile, with no error and
// a green suite (the old invariant test asserted the 25).
//
// Two tests, deliberately at different levels:
//  1. the SEEDER cannot write an override back (the mechanism), and
//  2. after the seed data is applied, the TICK reads the per-instance damage
//     (the property a player would actually notice).
// Neither restates the other: (1) would still pass if the tick's precedence
// were reversed, (2) would still pass if the seed row silently regrew a 25
// that the database happened to already hold.

const test = require('node:test');
const assert = require('node:assert');

const { CREATURE_BEHAVIORS } = require('../seeds/data/creatureBehaviors.js');
const { CREATURE_ABILITIES } = require('../seeds/data/creatureAbilities.js');
const { seedOneBehavior } = require('../scripts/seed-catalogs.js');
const { resolveBehavior } = require('../src/services/creatureBehaviors.js');
const { CreatureSim, GUARD_DAMAGE } = require('../src/authority/creatures.js');
const { scaleCreature } = require('../src/services/creatureLevel.js');

const GUARD_SEED = CREATURE_BEHAVIORS.find((b) => b.name === 'Guard');

// --------------------------------------------------------------------------
// 1. The seeder cannot write an override back onto the Guard row.
//
// Runs the REAL seedOneBehavior with the REAL shipped seed row against a
// recording fake, then inspects the statement it produced. Two things are
// asserted, and both are needed:
//   - the parameter bound to damage_override is NULL (the seed file no longer
//     authors one), and
//   - the ON CONFLICT branch resolves that column through COALESCE against
//     the column's own current value, so a NULL parameter PRESERVES rather
//     than clobbers.
// Assert only the first and someone could switch the UPDATE to
// `damage_override = EXCLUDED.damage_override` (which, with a NULL parameter,
// happens to keep working) or to a literal (which would not). Assert only the
// second and the seed row could go back to 25.
// --------------------------------------------------------------------------

function recordingDb() {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => { calls.push({ sql: String(sql), params }); return { rows: [], rowCount: 1 }; },
  };
}

// Which $n the INSERT column list binds to damage_override. Read out of the
// statement rather than hardcoded, so a column inserted ahead of it does not
// make this test silently inspect the wrong parameter.
function damageOverrideParamIndex(sql) {
  const cols = /INSERT INTO creature_behaviors\s*\(([\s\S]*?)\)\s*VALUES/i.exec(sql);
  assert.ok(cols, 'could not find the INSERT column list');
  const list = cols[1].split(',').map((c) => c.trim());
  const i = list.indexOf('damage_override');
  assert.ok(i >= 0, 'damage_override is not in the INSERT column list');
  return i;
}

test('seeding the shipped Guard row never writes a damage_override', async () => {
  assert.ok(GUARD_SEED, 'Guard is missing from the seed catalog');

  const db = recordingDb();
  await seedOneBehavior(db, GUARD_SEED);
  assert.equal(db.calls.length, 1, 'seedOneBehavior must issue exactly one statement');
  const { sql, params } = db.calls[0];

  const i = damageOverrideParamIndex(sql);
  assert.strictEqual(params[i], null,
    `the guard seed binds ${params[i]} to damage_override — any non-null value shadows every `
    + 'level-scaled guard\'s per-instance world_creatures.damage in the tick');

  // ...and the UPDATE branch keeps what the column already holds. $n is
  // 1-based; `i` is the 0-based column position, which is the same position
  // in the VALUES list, so the parameter is $(i+1).
  const placeholder = `$${i + 1}`;
  const update = /ON CONFLICT[\s\S]*$/i.exec(sql);
  assert.ok(update, 'the behaviour upsert must have an ON CONFLICT branch');
  const clause = new RegExp(
    `damage_override\\s*=\\s*COALESCE\\(\\s*\\${placeholder}(::real)?\\s*,\\s*creature_behaviors\\.damage_override\\s*\\)`,
    'i',
  );
  assert.match(update[0].replace(/\s+/g, ' '), clause,
    'damage_override must stay COALESCE(param, existing) on conflict: a NULL parameter has to '
    + 'PRESERVE the NULL migration 1714440173000 wrote, and any literal/EXCLUDED form here is how '
    + 'the flat-25 landmine gets planted again');
});

// --------------------------------------------------------------------------
// 2. After the seed data is applied, the tick reads the per-instance damage.
//
// This composes the real pieces end to end -- the shipped seed rows, the real
// resolveBehavior (the same function the live loaders use to turn catalog
// columns into a `bh`), and a real CreatureSim tick -- and measures the hp
// the hostile actually loses. Nothing here restates the tick's damage
// expression; the number comes from scaleCreature, the same curve
// villages.js places guards with.
// --------------------------------------------------------------------------

const MAP = { chunkSize: 64, isWalkable: () => true, speedAt: () => 1 };
const KEYS = new Set(['0,0']);

// A joined creature_behaviors row exactly as the live SELECTs deliver it
// (snake_case, `behavior_name` for the name, `abilities` as the json_agg
// array), built FROM the seed data so a re-authored damage_override lands
// here the same way it would land in the database.
function seededGuardBehavior() {
  const abilities = CREATURE_ABILITIES
    .filter((a) => a.behavior_name === 'Guard')
    .map(({ behavior_name: _n, ...cols }) => cols);
  assert.ok(abilities.length > 0, 'Guard has no seeded ability — the guard could not attack at all');

  return resolveBehavior({
    behavior_name: GUARD_SEED.name,
    aggro_radius: GUARD_SEED.aggro_radius,
    leash_radius: GUARD_SEED.leash_radius,
    chase_style: GUARD_SEED.chase_style,
    preferred_range: GUARD_SEED.preferred_range,
    move_speed_mult: GUARD_SEED.move_speed_mult,
    damage_override: GUARD_SEED.damage_override ?? null,
    abilities,
  });
}

test('a level-scaled guard running the seeded Guard profile hits for its own damage, not a flat 25', () => {
  // The Abyss: Hub's band top -- the world the ticket's ten-minute standoff
  // happened in. Derived from the shared curve, not typed in.
  const scaled = scaleCreature({ hp: 300, damage: GUARD_DAMAGE, defense: 10 }, 50);
  assert.equal(scaled.damage, 147.5, 'fixture check: the level-50 guard damage villages.js writes');
  assert.notEqual(scaled.damage, GUARD_DAMAGE, 'fixture check: scaling must actually change the number');

  const bh = seededGuardBehavior();
  assert.equal(bh.chaseStyle, 'guard', 'the seeded profile must still route into the guard branch');

  const s = new CreatureSim(MAP, () => 0.5);
  s.addCreatures([
    {
      id: 'g', type: 'Village Guard', x: 100, y: 100, hp: scaled.hp,
      faction: 'guard', home_x: 100, home_y: 100,
      level: 50, damage: scaled.damage, defense: scaled.defense,
      behavior: bh,
    },
    // Undefended, so the hp lost IS the raw swing: this test is about which
    // number the tick picks up, and mitigation would only blur that.
    { id: 'h', type: 'Void Line', x: 140, y: 100, hp: 100000, defense: 0 },
  ]);

  const before = s.creatures.get('h').hp;
  s.tick(0.5, KEYS, [], 1000);
  const dealt = before - s.creatures.get('h').hp;

  assert.equal(dealt, scaled.damage,
    `a seeded, level-scaled guard must swing for its own world_creatures.damage (${scaled.damage}); `
    + `it landed ${dealt}`);
  assert.notEqual(dealt, GUARD_DAMAGE,
    'the guard is back on the flat GUARD_DAMAGE — creature_behaviors.Guard.damage_override has '
    + 'been re-authored and is shadowing every scaled guard again');
});

// The same tick, with the override put BACK on the seeded row. This is the
// control: it proves the test above is measuring the override's absence and
// not something incidental about the fixture. If this ever stops flattening
// the guard, the precedence in authority/creatures.js changed and the test
// above no longer proves what it claims.
test('a re-authored damage_override would flatten that same guard (the control)', () => {
  const scaled = scaleCreature({ hp: 300, damage: GUARD_DAMAGE, defense: 10 }, 50);
  const bh = { ...seededGuardBehavior(), damageOverride: GUARD_DAMAGE };

  const s = new CreatureSim(MAP, () => 0.5);
  s.addCreatures([
    {
      id: 'g', type: 'Village Guard', x: 100, y: 100, hp: scaled.hp,
      faction: 'guard', home_x: 100, home_y: 100,
      level: 50, damage: scaled.damage, defense: scaled.defense,
      behavior: bh,
    },
    { id: 'h', type: 'Void Line', x: 140, y: 100, hp: 100000, defense: 0 },
  ]);

  const before = s.creatures.get('h').hp;
  s.tick(0.5, KEYS, [], 1000);
  assert.equal(before - s.creatures.get('h').hp, GUARD_DAMAGE,
    'the ticket\'s premise is gone: a damage_override no longer shadows per-instance damage, so '
    + 'removing it from the seed file is no longer what keeps guards scaled');
});
