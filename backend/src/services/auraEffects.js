// backend/src/services/auraEffects.js
// SOMET-604 (S3). Everything about an aura that is not a database or a tick:
// the vocabulary, the API validator, the row -> runtime resolver, and the ONE
// SQL fragment the live creature loader uses to resolve entity_types.auras.
//
// The vocabulary repeats the CHECKs in 1714440680000_aura_effects.js on
// purpose (DB = backstop, this = a readable 400). frontend auraForm.js is
// tested AGAINST this module so the three copies cannot drift.
const AURA_SIDES = ['allies', 'enemies'];
const AURA_SHAPES = ['ring', 'disc', 'particles'];
const AURA_LIMITS = Object.freeze({
  maxRadius: 2000, minTickMs: 100, maxTickMs: 5000, maxPulseMs: 10000, maxParticles: 64, maxNameLen: 200,
});
const HEX = /^#[0-9a-fA-F]{6}$/;

// A real number or a numeric string -- NOT Number(): Number('') / Number(null)
// are 0 and Number('260px') is NaN, and a blank field must not become a radius 0.
function asNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}
const isInt = (n) => Number.isInteger(n);

function auraEffectError(b) {
  if (!b || typeof b !== 'object') return 'body must be an object';
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) return 'name is required';
  if (name.length > AURA_LIMITS.maxNameLen) return `name must be ${AURA_LIMITS.maxNameLen} characters or fewer`;
  if (!AURA_SIDES.includes(b.target_side)) return `target_side must be one of ${AURA_SIDES.join(', ')}`;
  const r = asNum(b.radius);
  if (!(r > 0 && r <= AURA_LIMITS.maxRadius)) return `radius must be greater than 0 and at most ${AURA_LIMITS.maxRadius}`;
  for (const f of ['damage_mult', 'defense_mult', 'speed_mult']) {
    if (b[f] != null && !(asNum(b[f]) > 0)) return `${f} must be greater than 0`;
  }
  if (b.dot_dps != null && !(asNum(b.dot_dps) >= 0)) return 'dot_dps must be 0 or greater';
  if (b.target_side === 'allies' && asNum(b.dot_dps ?? 0) > 0) {
    return 'only an enemies aura can deal damage over time';
  }
  if (b.tick_ms != null) {
    const t = asNum(b.tick_ms);
    if (!isInt(t) || t < AURA_LIMITS.minTickMs || t > AURA_LIMITS.maxTickMs) {
      return `tick_ms must be a whole number between ${AURA_LIMITS.minTickMs} and ${AURA_LIMITS.maxTickMs}`;
    }
  }
  if (b.shape != null && !AURA_SHAPES.includes(b.shape)) return `shape must be one of ${AURA_SHAPES.join(', ')}`;
  if (b.color != null && !HEX.test(b.color)) return 'color must be a #rrggbb hex colour';
  if (b.pulse_ms != null) {
    const p = asNum(b.pulse_ms);
    if (!isInt(p) || p < 0 || p > AURA_LIMITS.maxPulseMs) return `pulse_ms must be a whole number between 0 and ${AURA_LIMITS.maxPulseMs}`;
  }
  if (b.particle_count != null) {
    const n = asNum(b.particle_count);
    if (!isInt(n) || n < 0 || n > AURA_LIMITS.maxParticles) return `particle_count must be a whole number between 0 and ${AURA_LIMITS.maxParticles}`;
  }
  if (b.particle_lifetime_ms != null && !(asNum(b.particle_lifetime_ms) > 0)) return 'particle_lifetime_ms must be greater than 0';
  if (b.particle_size != null && !(asNum(b.particle_size) >= 0)) return 'particle_size must be 0 or greater';
  for (const f of ['particle_spread', 'particle_speed', 'particle_gravity']) {
    if (b[f] != null && !Number.isFinite(asNum(b[f]))) return `${f} must be a number`;
  }
  return null;
}

// Mult fallback is 1, never 0: same trap creatureBehaviors.js documents.
function num(v, fallback) {
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// One json_build_object row from AURAS_LATERAL -> the runtime shape, or null
// for a row that cannot do anything sane (no name, unknown side, radius <= 0).
function resolveAuraDef(row) {
  if (!row || typeof row.name !== 'string' || !row.name) return null;
  if (!AURA_SIDES.includes(row.target_side)) return null;
  const radius = num(row.radius, 0);
  if (!(radius > 0)) return null;
  return {
    name: row.name,
    targetSide: row.target_side,
    radius,
    damageMult: num(row.damage_mult, 1),
    defenseMult: num(row.defense_mult, 1),
    speedMult: num(row.speed_mult, 1),
    dotDps: num(row.dot_dps, 0),
    dotElement: typeof row.dot_element === 'string' ? row.dot_element : 'physical',
    tickMs: num(row.tick_ms, 1000),
  };
}

// Unknown-name warnings are once per NAME per process: 32 Champions binding a
// deleted aura must produce one line, not 32 per chunk load.
const warnedUnknown = new Set();
function __resetAuraWarnings() { warnedUnknown.clear(); }

// The single place an instance's auras are decided (addCreatures calls it),
// mirroring resolveInstanceBehavior's priority:
//  1. a loader row (aura_defs present) -- the live path, CREATURE_JOINED_SELECT;
//  2. an already-resolved camelCase `auras` array (test fixtures; S1's hydration);
//  3. nothing -> [].
function resolveInstanceAuras(c, warn = console.warn) {
  if (Array.isArray(c.aura_defs)) {
    const defs = c.aura_defs.map(resolveAuraDef).filter(Boolean);
    const known = new Set(defs.map((d) => d.name));
    const names = Array.isArray(c.aura_names) ? c.aura_names : [];
    for (const n of names) {
      if (typeof n === 'string' && !known.has(n) && !warnedUnknown.has(n)) {
        warnedUnknown.add(n);
        warn(`[auras] entity type "${c.type}" binds unknown aura "${n}" -- ignored`);
      }
    }
    return defs;
  }
  if (Array.isArray(c.auras)) {
    return c.auras
      .filter((a) => a && typeof a === 'object' && AURA_SIDES.includes(a.targetSide) && a.radius > 0)
      .map((a) => ({ damageMult: 1, defenseMult: 1, speedMult: 1, dotDps: 0, dotElement: 'physical', tickMs: 1000, ...a }));
  }
  return [];
}

// Appended to CREATURE_JOINED_SELECT after ABILITIES_LATERAL. `et` is the
// entity_types alias there. jsonb `?` = "array contains this string", so a
// NULL or [] auras column matches nothing and yields '[]'. The dot_* fields
// ride along now so S4 adds no second loader.
const AURAS_LATERAL = `
         LEFT JOIN LATERAL (
           SELECT COALESCE(json_agg(json_build_object(
                    'name', ae.name, 'target_side', ae.target_side, 'radius', ae.radius,
                    'damage_mult', ae.damage_mult, 'defense_mult', ae.defense_mult,
                    'speed_mult', ae.speed_mult, 'dot_dps', ae.dot_dps,
                    'dot_element', ae.dot_element, 'tick_ms', ae.tick_ms
                  ) ORDER BY ae.name), '[]'::json) AS aura_defs
             FROM aura_effects ae
            WHERE jsonb_typeof(et.auras) = 'array' AND et.auras ? ae.name
         ) au ON true`;

module.exports = {
  AURA_SIDES, AURA_SHAPES, AURA_LIMITS,
  auraEffectError, resolveAuraDef, resolveInstanceAuras, __resetAuraWarnings, AURAS_LATERAL,
};
