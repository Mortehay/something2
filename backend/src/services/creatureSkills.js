// SOMET-608 (S6). Pure normalisation of a creature_behavior_skills join row
// into the object CreatureSim's tick reads -- no database, no clock, no
// randomness. Mirrors services/creatureBehaviors.js's resolveAbility/
// resolveAbilities exactly, on purpose: skills and abilities are siblings
// (a behaviour's repertoire, read via the same json_agg-over-LATERAL shape),
// and giving them two different normalisation styles would be a trap for
// whoever edits one and forgets the other.

// slam/nova/summon/projectile are the ordinary kinds. charge/blink/rain are the boss kinds
// creatures.js already resolves (they used to be reachable only through bossAI.js, i.e.
// dungeon bosses); chain is a lightning that jumps from player to player.
const KINDS = ['slam', 'nova', 'summon', 'projectile', 'charge', 'blink', 'rain', 'chain'];
const ELEMENTS = ['physical', 'arcane', 'fire', 'ice', 'lightning'];
const ZONE_PATTERNS = ['scatter', 'ring', 'cross'];
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
  // Boss-kit extras (creature_skills.params).
  hits: 1,
  dashDistance: 0,
  innerRadius: 0,
  projectileCount: 1,
  projectileSpread: 0,
  projectileSpeed: null,
  pull: 0,
  ultimate: false,
  zones: null,
  // Binding gates (creature_behavior_skills): opens in a later phase / only once enraged.
  minPhase: 1,
  requiresEnrage: false,
});

function num(v, fallback) {
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clampInt(v, lo, hi, fallback) {
  const n = Math.trunc(num(v, fallback));
  return Math.max(lo, Math.min(hi, n));
}

// The hazard positions of a `rain` skill, relative to its target. Deterministic: the
// telegraph is a promise, and the sim rotates the whole pattern per cast (creatures.js
// planSkill) so it is not the same picture every time.
//   scatter  the first zone on the target (standing still is never safe), the rest spread
//            evenly over a disc (golden-angle spiral)
//   ring     `count` zones on a circle of radius `spread` AROUND the target: step between two
//   cross    four arms out from the target
function buildZones(z, defaultCount) {
  const cfg = z && typeof z === 'object' && !Array.isArray(z) ? z : {};
  const n = clampInt(cfg.count, 1, 12, defaultCount);
  const spread = Math.max(0, num(cfg.spread, 380));
  const pattern = ZONE_PATTERNS.includes(cfg.pattern) ? cfg.pattern : 'scatter';
  const out = [];
  if (pattern === 'ring') {
    for (let i = 0; i < n; i += 1) {
      const a = (i / n) * Math.PI * 2;
      out.push({ dx: Math.cos(a) * spread, dy: Math.sin(a) * spread });
    }
    return out;
  }
  out.push({ dx: 0, dy: 0 });
  if (pattern === 'cross') {
    for (let i = 1; i < n; i += 1) {
      const arm = (i - 1) % 4;
      const step = Math.floor((i - 1) / 4) + 1;
      const a = (arm * Math.PI) / 2;
      out.push({ dx: Math.cos(a) * (spread / 2) * step, dy: Math.sin(a) * (spread / 2) * step });
    }
    return out;
  }
  for (let i = 1; i < n; i += 1) {
    const r = Math.sqrt(i / n) * spread;
    const a = i * 2.399963;
    out.push({ dx: Math.cos(a) * r, dy: Math.sin(a) * r });
  }
  return out;
}

// power_scale multiplies radius, damage_mult and summon_count (spec §3.4).
// summon_count is rounded and floored at 1 -- a 0.1 scale must still summon
// SOMETHING, not nothing, or the skill silently becomes a no-op at the low
// end of the slider.
function resolveSkill(row) {
  const powerScale = num(row.power_scale, 1);
  const p = row.params && typeof row.params === 'object' && !Array.isArray(row.params) ? row.params : {};
  const kind = KINDS.includes(row.kind) ? row.kind : 'slam';
  return {
    slot: Math.max(1, Math.trunc(num(row.slot, 1))),
    id: num(row.skill_id, null),
    name: typeof row.name === 'string' && row.name ? row.name : 'Skill',
    kind,
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
    hits: clampInt(p.hits, 1, 8, 1),
    dashDistance: kind === 'charge' ? Math.max(0, num(p.dash_distance, 500)) : 0,
    innerRadius: Math.max(0, num(p.inner_radius, 0)) * powerScale,
    projectileCount: clampInt(p.proj_count, 1, 12, 1),
    projectileSpread: Math.max(0, num(p.proj_spread, 0)),
    projectileSpeed: p.proj_speed == null ? null : Math.max(1, num(p.proj_speed, 400)),
    pull: Math.max(0, num(p.pull, 0)),
    ultimate: p.ultimate === true,
    zones: kind === 'rain' ? buildZones(p.zones, 5) : null,
    minPhase: clampInt(row.min_phase, 1, 4, 1),
    requiresEnrage: row.requires_enrage === true,
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

// creature_skills.params: the optional boss-kit knobs. The same ranges resolveSkill clamps
// to, stated as a readable 400 instead of a silent clamp.
function paramsError(p) {
  if (p == null) return null;
  if (typeof p !== 'object' || Array.isArray(p)) return 'params must be an object';
  const check = (key, lo, hi) => {
    if (p[key] == null) return null;
    const n = asNum(p[key]);
    return Number.isFinite(n) && n >= lo && n <= hi ? null : `params.${key} must be between ${lo} and ${hi}`;
  };
  const bad = check('hits', 1, 8) || check('dash_distance', 0, 1500) || check('inner_radius', 0, 2000)
    || check('proj_count', 1, 12) || check('proj_spread', 0, 6.283) || check('proj_speed', 1, 1500)
    || check('pull', 0, 600);
  if (bad) return bad;
  if (p.zones != null) {
    const z = p.zones;
    if (typeof z !== 'object' || Array.isArray(z)) return 'params.zones must be an object';
    if (z.count != null && !(Number.isInteger(asNum(z.count)) && asNum(z.count) >= 1 && asNum(z.count) <= 12)) {
      return 'params.zones.count must be a whole number between 1 and 12';
    }
    if (z.spread != null && !(asNum(z.spread) >= 0 && asNum(z.spread) <= 1500)) {
      return 'params.zones.spread must be between 0 and 1500';
    }
    if (z.pattern != null && !ZONE_PATTERNS.includes(z.pattern)) {
      return `params.zones.pattern must be one of ${ZONE_PATTERNS.join(', ')}`;
    }
  }
  return null;
}

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
  return paramsError(b.params);
}

module.exports = {
  resolveSkill, resolveSkills, creatureSkillError, DEFAULT_SKILL, KINDS, ELEMENTS, ZONE_PATTERNS, buildZones,
};
