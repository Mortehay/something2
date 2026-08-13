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
const CHASE_STYLES = ['charge', 'kite', 'skirmish', 'hold', 'ambush', 'guard', 'skittish'];
// Mirrors creature_abilities' element CHECK constraint (migration
// 1714440083000), which additionally allows NULL -- see resolveAbility.
const ELEMENTS = ['physical', 'fire', 'ice', 'lightning'];

// Today's hostile attack, and the fallback for a behaviour with no ability
// rows. Must equal CONTACT_RANGE (60) and CREATURE_ATTACK_COOLDOWN (1.0) in
// authority/creatures.js, for the same reason DEFAULT_BEHAVIOR's movement
// fields must equal AGGRO_RADIUS/LEASH_RADIUS.
const DEFAULT_ABILITY = Object.freeze({
  slot: 1,
  name: 'Attack',
  attackKind: 'melee',
  attackRange: 60,
  attackCooldown: 1,
  projectileSpeed: 0,
  projectileRadius: 0,
  element: null,      // null = use the creature type's attack_element
  damageMult: 1,
  knockback: 0,
});

// Today's hostile constants, and the fallback for a creature with no profile.
// These MUST equal AGGRO_RADIUS (400) and LEASH_RADIUS (800) in
// authority/creatures.js -- that equality is what makes P2a behaviour-neutral,
// and creature_behavior_golden.test.js is what proves it. The attack itself
// lives in `abilities` (SOMET-253): the flat attackKind/attackRange/
// attackCooldown/projectileSpeed/projectileRadius fields are GONE from here,
// deliberately, so the primary attack has exactly one source of truth.
//
// The array is frozen alongside the object: DEFAULT_BEHAVIOR is spread (not
// cloned deeply) by resolveBehavior and by resolveInstanceBehavior, so an
// unfrozen array would be shared by reference across every fallback creature
// in the process and one caller's push would arm them all.
const DEFAULT_BEHAVIOR = Object.freeze({
  name: 'Line',
  abilities: Object.freeze([DEFAULT_ABILITY]),
  aggroRadius: 400,
  leashRadius: 800,
  chaseStyle: 'charge',
  preferredRange: 0,
  moveSpeedMult: 1,
  damageOverride: null,
  // SOMET-253 Task 4: aura_radius 0 means "not a pack leader" -- Task 5's
  // consumer never applies a buff/debuff within a zero-radius aura, so this
  // is a true no-op until then. The three multipliers default to 1
  // (neutral), never 0: a NULL aura_damage_mult resolving to Number(null)=0
  // would make every buffed creature deal NOTHING, the same trap as the
  // ability cooldown in Task 2.
  auraRadius: 0,
  auraDamageMult: 1,
  auraDefenseMult: 1,
  auraSpeedMult: 1,
  // Per-rung gold fallback (see loot.js, wired up in Task 5). 0 means "no
  // fallback range", matching the migration's column default.
  goldMin: 0,
  goldMax: 0,
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

// One creature_abilities row (as delivered by the json_agg in
// authority/creatures.js's ABILITIES_LATERAL, i.e. snake_case keys).
function resolveAbility(row) {
  return {
    slot: Math.max(1, Math.trunc(num(row.slot, 1))),
    name: typeof row.name === 'string' && row.name ? row.name : DEFAULT_ABILITY.name,
    attackKind: oneOf(row.attack_kind, ATTACK_KINDS, DEFAULT_ABILITY.attackKind),
    attackRange: num(row.attack_range, DEFAULT_ABILITY.attackRange),
    attackCooldown: num(row.attack_cooldown, DEFAULT_ABILITY.attackCooldown),
    projectileSpeed: num(row.projectile_speed, DEFAULT_ABILITY.projectileSpeed),
    projectileRadius: num(row.projectile_radius, DEFAULT_ABILITY.projectileRadius),
    // null is meaningful ("inherit the type's element"), so an absent or
    // unrecognised value resolves to null rather than to 'physical' -- a
    // hard 'physical' here would silently strip a Caster's fire.
    element: ELEMENTS.includes(row.element) ? row.element : null,
    // 0 is a real value (a pure status-rider ability that applies an element
    // but no damage) and must survive, so this is num() with a default,
    // never `|| 1`.
    damageMult: num(row.damage_mult, DEFAULT_ABILITY.damageMult),
    knockback: num(row.knockback, DEFAULT_ABILITY.knockback),
  };
}

// Sorted by slot HERE as well as by the SQL's ORDER BY: the SQL ordering
// covers the live path, this covers every hand-built fixture and any caller
// that assembles the array itself. Selection reads "lowest slot first" off
// array order, so an unsorted array silently reprioritises a creature's moves.
function resolveAbilities(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [{ ...DEFAULT_ABILITY }];
  return rows.map(resolveAbility).sort((a, b) => a.slot - b.slot);
}

// `row` is a joined row from loadCreatureTypes, whose behaviour columns are
// aliased with a `behavior_` prefix for `name` only (the rest do not collide
// with entity_types). A null/undefined row is the no-profile case.
function resolveBehavior(row) {
  if (!row) return { ...DEFAULT_BEHAVIOR };
  return {
    name: typeof row.behavior_name === 'string' && row.behavior_name
      ? row.behavior_name : DEFAULT_BEHAVIOR.name,
    // The attack comes from creature_abilities, never from the parent row's
    // own attack_* columns -- Task 3 drops those columns entirely. A
    // behaviour whose join returned no ability rows gets the single default
    // ability, which is exactly today's melee 60 / 1.0s contact attack.
    abilities: resolveAbilities(row.abilities),
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
    auraRadius: num(row.aura_radius, DEFAULT_BEHAVIOR.auraRadius),
    auraDamageMult: num(row.aura_damage_mult, DEFAULT_BEHAVIOR.auraDamageMult),
    auraDefenseMult: num(row.aura_defense_mult, DEFAULT_BEHAVIOR.auraDefenseMult),
    auraSpeedMult: num(row.aura_speed_mult, DEFAULT_BEHAVIOR.auraSpeedMult),
    // Aliased `behavior_gold_min`/`behavior_gold_max`, not the bare
    // `gold_min`/`gold_max` entity_types already owns: loadCreatureTypes'
    // SELECT carries both e.gold_min (the entity type's own range, used by
    // creatureGold) and b.gold_min (this fallback) in one row, and an
    // unaliased pair would collide into a single pg column with the later
    // one silently winning -- see ABILITIES_LATERAL's sibling comment on
    // `behavior_name` for the same rule applied to the name column.
    goldMin: num(row.behavior_gold_min, DEFAULT_BEHAVIOR.goldMin),
    goldMax: num(row.behavior_gold_max, DEFAULT_BEHAVIOR.goldMax),
  };
}

module.exports = {
  resolveBehavior, resolveAbilities,
  DEFAULT_BEHAVIOR, DEFAULT_ABILITY,
  ATTACK_KINDS, CHASE_STYLES, ELEMENTS,
};
