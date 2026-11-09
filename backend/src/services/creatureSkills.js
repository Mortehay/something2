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
// zone leaves damaging ground behind (lava pools, a burning ring, a frost field); mark puts a
// delayed explosion on players (the answer is to spread out); shelter hits everyone EXCEPT those
// standing in the safe circle it shows (the answer is to run there).
const KINDS = ['slam', 'nova', 'summon', 'projectile', 'charge', 'blink', 'rain', 'chain', 'zone', 'mark', 'shelter'];
const HAZARD_PATTERNS = ['targets', 'ring', 'scatter'];
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
  // Crowd control and debuffs the skill's area puts on a player it hits: { rootS, slowPct, slowS, silenceS }.
  status: null,
  hazard: null,
  mark: null,
  shelter: null,
  waves: 1,
  waveMs: 0,
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

// What a hit puts on a player. null when the skill carries none.
function buildStatus(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  const rootS = Math.min(8, Math.max(0, num(s.root_s, 0)));
  const slowPct = Math.min(95, Math.max(0, num(s.slow_pct, 0)));
  const slowS = slowPct > 0 ? Math.min(12, Math.max(0, num(s.slow_s, 3))) : 0;
  const silenceS = Math.min(8, Math.max(0, num(s.silence_s, 0)));
  return rootS > 0 || slowPct > 0 || silenceS > 0 ? { rootS, slowPct, slowS, silenceS } : null;
}

// Ground that stays: `pattern` says where the pools go (on the players, in a ring around the boss, or
// scattered), `lingerMs` how long they last, `tickMs` how often they hurt; `slowPct` is a slow the
// ground applies while you stand in it (a frost field may do no damage at all: damage_mult 0).
function buildHazard(h) {
  const cfg = h && typeof h === 'object' && !Array.isArray(h) ? h : {};
  return {
    pattern: HAZARD_PATTERNS.includes(cfg.pattern) ? cfg.pattern : 'targets',
    count: clampInt(cfg.count, 1, 8, 3),
    spread: Math.max(0, num(cfg.spread, 400)),
    inner: Math.max(0, num(cfg.inner, 0)),
    outer: Math.max(0, num(cfg.outer, 0)),
    lingerMs: clampInt(cfg.linger_ms, 1000, 30000, 8000),
    tickMs: clampInt(cfg.tick_ms, 200, 2000, 500),
    slowPct: Math.min(95, Math.max(0, num(cfg.slow_pct, 0))),
  };
}

// A delayed explosion on players. `targets` is how many are marked ('all' = everyone in range); the fuse
// is the skill's own telegraph_ms and the blast radius its radius, so overlapping players take it twice.
function buildMark(m) {
  const cfg = m && typeof m === 'object' && !Array.isArray(m) ? m : {};
  const all = cfg.targets === 'all';
  return { all, targets: all ? 8 : clampInt(cfg.targets, 1, 8, 1) };
}

// A circle of safety: `safeRadius` wide, `safeDist` from the boss toward its target; everything within
// `reach` of the boss and OUTSIDE it is hit.
function buildShelter(s) {
  const cfg = s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  return {
    safeRadius: Math.max(40, num(cfg.safe_radius, 140)),
    safeDist: Math.max(0, num(cfg.safe_dist, 380)),
    reach: Math.max(200, num(cfg.reach, 1100)),
  };
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
    status: buildStatus(p.status),
    hazard: kind === 'zone' ? buildHazard(p.hazard) : null,
    mark: kind === 'mark' ? buildMark(p.mark) : null,
    shelter: kind === 'shelter' ? buildShelter(p.shelter) : null,
    // A rain that comes in `waves` rounds, `waveMs` apart (Thunderstorm).
    waves: kind === 'rain' ? clampInt(p.waves, 1, 8, 1) : 1,
    waveMs: kind === 'rain' ? clampInt(p.wave_ms, 400, 3000, 1000) : 0,
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
    || check('pull', 0, 600) || check('waves', 1, 8) || check('wave_ms', 400, 3000);
  if (bad) return bad;
  const sub = (obj, name, rules) => {
    if (obj == null) return null;
    if (typeof obj !== 'object' || Array.isArray(obj)) return `params.${name} must be an object`;
    for (const [key, lo, hi] of rules) {
      if (obj[key] == null) continue;
      const n = asNum(obj[key]);
      if (!(Number.isFinite(n) && n >= lo && n <= hi)) return `params.${name}.${key} must be between ${lo} and ${hi}`;
    }
    return null;
  };
  const subBad = sub(p.status, 'status', [['root_s', 0, 8], ['slow_pct', 0, 95], ['slow_s', 0, 12], ['silence_s', 0, 8]])
    || sub(p.hazard, 'hazard', [['count', 1, 8], ['spread', 0, 1500], ['inner', 0, 2000], ['outer', 0, 2000],
      ['linger_ms', 1000, 30000], ['tick_ms', 200, 2000], ['slow_pct', 0, 95]])
    || sub(p.shelter, 'shelter', [['safe_radius', 40, 1000], ['safe_dist', 0, 1500], ['reach', 200, 2500]]);
  if (subBad) return subBad;
  if (p.hazard && p.hazard.pattern != null && !HAZARD_PATTERNS.includes(p.hazard.pattern)) {
    return `params.hazard.pattern must be one of ${HAZARD_PATTERNS.join(', ')}`;
  }
  if (p.mark != null) {
    if (typeof p.mark !== 'object' || Array.isArray(p.mark)) return 'params.mark must be an object';
    const t = p.mark.targets;
    if (t != null && t !== 'all' && !(Number.isInteger(asNum(t)) && asNum(t) >= 1 && asNum(t) <= 8)) {
      return "params.mark.targets must be 'all' or a whole number between 1 and 8";
    }
  }
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
  resolveSkill, resolveSkills, creatureSkillError, DEFAULT_SKILL, KINDS, ELEMENTS, ZONE_PATTERNS, HAZARD_PATTERNS, buildZones,
};
