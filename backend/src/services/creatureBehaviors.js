// Pure normalisation of a creature_behaviors row into the object the sim
// consumes. No database, no clock, no randomness.
//
// The point of this module is that CreatureSim never sees a partial or
// malformed behaviour. A missing column, a NULL, a value that predates a CHECK
// constraint -- all of them resolve to the Line fallback rather than reaching
// the tick loop as NaN and freezing a creature in place.

// These duplicate the CHECK constraints in migration
// 1714440080000_creature_behaviors.js. Deliberate, and documented there:
// a value rejected only in JS is a value that reaches the database, and a
// value rejected only in SQL is a value that reaches the sim from a row
// written before the constraint existed.
const ATTACK_KINDS = ['melee', 'ranged', 'cast'];
const CHASE_STYLES = ['charge', 'kite', 'skirmish', 'hold', 'ambush', 'guard'];

// Today's hostile constants, and the fallback for a creature with no profile.
// These MUST equal CONTACT_RANGE (60), CREATURE_ATTACK_COOLDOWN (1.0),
// AGGRO_RADIUS (400) and LEASH_RADIUS (800) in authority/creatures.js -- that
// equality is what makes P2a behaviour-neutral, and
// creature_behavior_golden.test.js is what proves it.
const DEFAULT_BEHAVIOR = Object.freeze({
  name: 'Line',
  attackKind: 'melee',
  attackRange: 60,
  attackCooldown: 1,
  projectileSpeed: 0,
  projectileRadius: 0,
  aggroRadius: 400,
  leashRadius: 800,
  chaseStyle: 'charge',
  preferredRange: 0,
  moveSpeedMult: 1,
  damageOverride: null,
});

// A finite number, or the fallback. `pg` hands back `real` columns as numbers
// and `numeric` as strings, so Number() is applied either way.
// NULL/undefined in a column means the value was never set (not zero): a NULL
// attack_cooldown of Number(null)=0 gives unbounded fire rate, a NULL
// attack_range of 0 makes the creature unable to attack. These are active
// dangers. Only safe interpretation is to fall back to the documented default.
function num(v, fallback) {
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function oneOf(v, allowed, fallback) {
  return allowed.includes(v) ? v : fallback;
}

// `row` is a joined row from loadCreatureTypes, whose behaviour columns are
// aliased with a `behavior_` prefix for `name` only (the rest do not collide
// with entity_types). A null/undefined row is the no-profile case.
function resolveBehavior(row) {
  if (!row) return { ...DEFAULT_BEHAVIOR };
  return {
    name: typeof row.behavior_name === 'string' && row.behavior_name
      ? row.behavior_name : DEFAULT_BEHAVIOR.name,
    attackKind: oneOf(row.attack_kind, ATTACK_KINDS, DEFAULT_BEHAVIOR.attackKind),
    attackRange: num(row.attack_range, DEFAULT_BEHAVIOR.attackRange),
    attackCooldown: num(row.attack_cooldown, DEFAULT_BEHAVIOR.attackCooldown),
    projectileSpeed: num(row.projectile_speed, DEFAULT_BEHAVIOR.projectileSpeed),
    projectileRadius: num(row.projectile_radius, DEFAULT_BEHAVIOR.projectileRadius),
    aggroRadius: num(row.aggro_radius, DEFAULT_BEHAVIOR.aggroRadius),
    leashRadius: num(row.leash_radius, DEFAULT_BEHAVIOR.leashRadius),
    chaseStyle: oneOf(row.chase_style, CHASE_STYLES, DEFAULT_BEHAVIOR.chaseStyle),
    preferredRange: num(row.preferred_range, DEFAULT_BEHAVIOR.preferredRange),
    moveSpeedMult: num(row.move_speed_mult, DEFAULT_BEHAVIOR.moveSpeedMult),
    // null means "use the creature's own instance damage". 0 is a real value
    // and must survive, so this is an explicit null check, not `??` on a
    // falsy test.
    damageOverride: row.damage_override == null
      ? null : num(row.damage_override, null),
  };
}

module.exports = { resolveBehavior, DEFAULT_BEHAVIOR, ATTACK_KINDS, CHASE_STYLES };
