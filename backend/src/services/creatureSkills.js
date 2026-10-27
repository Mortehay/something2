// SOMET-608 (S6). Pure normalisation of a creature_behavior_skills join row
// into the object CreatureSim's tick reads -- no database, no clock, no
// randomness. Mirrors services/creatureBehaviors.js's resolveAbility/
// resolveAbilities exactly, on purpose: skills and abilities are siblings
// (a behaviour's repertoire, read via the same json_agg-over-LATERAL shape),
// and giving them two different normalisation styles would be a trap for
// whoever edits one and forgets the other.
const KINDS = ['slam', 'nova', 'summon', 'projectile'];
const ELEMENTS = ['physical', 'arcane', 'fire', 'ice', 'lightning'];
const MAX_NAME_LEN = 200; // mirrors MAX_CATALOG_NAME_LEN (index.js) -- own constant, no cross-import, same convention auraEffects.js already uses

// The completion template for a HAND-BUILT skill object (camelCase, same
// role DEFAULT_ABILITY plays for abilities): a test fixture or any other
// caller that assembles `behavior.skills` directly, rather than through a DB
// row, gets every field it omits filled in sanely. Without this, a skill
// missing `cooldownMs` would stamp `undefined` into `_skillCd`, and
// `undefined > 0` is false forever -- the creature would recast it every
// single tick, the same inertness-by-omission bug completeAbilities exists
// to prevent for ordinary attacks.
const DEFAULT_SKILL = Object.freeze({
  slot: 1,
  id: null,
  name: 'Skill',
  kind: 'slam',
  telegraphMs: 0,
  cooldownMs: 1000,
  range: 0,
  radius: 0,
  damageMult: 1,
  element: null,
  summonEntity: null,
  summonCount: 1,
  vfx: null,
  powerScale: 1,
});

function num(v, fallback) {
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// power_scale multiplies radius, damage_mult and summon_count (spec §3.4).
// summon_count is rounded and floored at 1 -- a 0.1 scale must still summon
// SOMETHING, not nothing, or the skill silently becomes a no-op at the low
// end of the slider.
function resolveSkill(row) {
  const powerScale = num(row.power_scale, 1);
  return {
    slot: Math.max(1, Math.trunc(num(row.slot, 1))),
    id: num(row.skill_id, null),
    name: typeof row.name === 'string' && row.name ? row.name : 'Skill',
    kind: KINDS.includes(row.kind) ? row.kind : 'slam',
    telegraphMs: Math.max(0, Math.trunc(num(row.telegraph_ms, 0))),
    cooldownMs: Math.max(1, Math.trunc(num(row.cooldown_ms, 1000))),
    range: num(row.range, 0),
    radius: num(row.radius, 0) * powerScale,
    damageMult: num(row.damage_mult, 1) * powerScale,
    // null is meaningful ("inherit the caster's own attack element"), so an
    // absent/unrecognised value resolves to null, never to 'physical'.
    element: ELEMENTS.includes(row.element) ? row.element : null,
    summonEntity: typeof row.summon_entity === 'string' && row.summon_entity ? row.summon_entity : null,
    summonCount: Math.max(1, Math.round(num(row.summon_count, 1) * powerScale)),
    vfx: row.vfx && typeof row.vfx === 'object' ? row.vfx : null,
    powerScale,
  };
}

// Sorted by slot HERE as well as by the SQL's ORDER BY (SKILLS_LATERAL),
// for the same reason resolveAbilities sorts: selection reads "lowest slot
// first" off array order, and an unsorted array would silently reprioritise
// a creature's moves for any hand-built fixture or caller that skips the SQL.
function resolveSkills(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  return rows.map(resolveSkill).sort((a, b) => a.slot - b.slot);
}

// SOMET-608 (S6). Mirrors the DB CHECK constraints in
// 1714440691000_creature_skills.js so a bad value is a readable 400 rather
// than a raw 500 from the constraint -- same role behaviorFieldError /
// abilityFieldError play for creature_behaviors / creature_abilities.
function asNum(v) { return typeof v === 'string' ? Number(v) : v; }

function creatureSkillError(b) {
  if (!b || typeof b !== 'object') return 'body must be an object';
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) return 'name is required';
  if (name.length > MAX_NAME_LEN) return `name must be ${MAX_NAME_LEN} characters or fewer`;
  if (!KINDS.includes(b.kind)) return `kind must be one of ${KINDS.join(', ')}`;
  const telegraphMs = asNum(b.telegraph_ms ?? 0);
  if (!(Number.isFinite(telegraphMs) && telegraphMs >= 0 && telegraphMs <= 3000)) {
    return 'telegraph_ms must be a whole number between 0 and 3000';
  }
  if (!(asNum(b.cooldown_ms) > 0)) return 'cooldown_ms must be greater than 0';
  if (b.radius != null && !(asNum(b.radius) >= 0)) return 'radius must be 0 or greater';
  if (b.range != null && !(asNum(b.range) >= 0)) return 'range must be 0 or greater';
  if (b.damage_mult != null && !(asNum(b.damage_mult) >= 0)) return 'damage_mult must be 0 or greater';
  if (b.element != null && !ELEMENTS.includes(b.element)) return `element must be one of ${ELEMENTS.join(', ')}`;
  if (b.summon_count != null && !(asNum(b.summon_count) >= 1)) return 'summon_count must be 1 or greater';
  // vfx mirrors entity_types.vfx's own shape -- an object or absent, never a
  // bare string (the mistake that shape's own validation already guards
  // against elsewhere), so a typo'd single binding cannot silently replace
  // the whole { telegraph, cast, impact } map.
  if (b.vfx != null && (typeof b.vfx !== 'object' || Array.isArray(b.vfx))) {
    return 'vfx must be an object, e.g. { "telegraph": "...", "cast": "...", "impact": "..." }';
  }
  return null;
}

module.exports = {
  resolveSkill, resolveSkills, creatureSkillError, DEFAULT_SKILL, KINDS, ELEMENTS,
};
