// Attack-VFX render store. Pure and canvas-free — mirrors core/blasts.js — so
// the lifetime, easing and iso projection maths are unit-testable under
// vitest's `node` environment, with RenderSystem as a thin consumer.
//
// The server emits attacks on a single tick's `state` frame and never repeats
// them, so the client keeps its own short-lived list and animates each entry
// off its ARRIVAL time.

// Used when an effect row carries no usable duration. Matches the column
// default in the vfx_effects migration.
export const DEFAULT_DURATION_MS = 180;

// The effect library, keyed by the name the server sends. Rows without a name
// are unreferenceable, so they are dropped rather than indexed under
// `undefined`.
export function indexEffects(rows) {
  const out = {};
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    if (r && typeof r.name === "string" && r.name) out[r.name] = r;
  }
  return out;
}

function duration(def) {
  const d = def && Number(def.duration_ms);
  return Number.isFinite(d) && d > 0 ? d : DEFAULT_DURATION_MS;
}

// SOMET-286 — the cue for an attack a RULE refused (today: a village guard,
// which no player damage can reach). A shield glint on the target, drawn by
// RenderSystem's `block` shape.
//
// Built in, NOT a vfx_effects row, and that is the point. Every other effect
// here is weapon or creature flavour, deliberately admin-authorable, and
// deliberately degrades to nothing when the row it names is renamed or deleted
// (see addEffects below). A refusal cannot afford that failure mode: dropping
// it puts the player back in front of the exact bug this ticket fixes — an
// attack on a guard that looks identical to a swing at empty ground. Nothing
// an admin edits can take this cue away.
//
// `shape: "block"` is therefore a CLIENT-ONLY shape name, outside the
// vfx_effects CHECK constraint's vocabulary on purpose: no authored row can
// name it, and no authored row needs to.
export const BLOCK_EFFECT_DEF = {
  name: "guard_block", shape: "block", color: "#ffd67a", width: 3,
  duration_ms: 380, ease: "out", fade: true,
};

// Append this tick's attacks. Each is stamped with its ARRIVAL time (not a
// server timestamp): arrival is the only clock both ends agree on without
// clock sync, the same reasoning addBlasts documents.
//
// An event whose name is not in the library is DROPPED, not drawn blank: vfx
// bindings are jsonb with no FK, so renaming a vfx_effects row orphans every
// binding pointing at it. That has to degrade to nothing rather than throw
// inside the socket handler.
export function addEffects(list, events, nowMs, defs) {
  if (!Array.isArray(events)) return list;
  for (const e of events) {
    if (!e || !Number.isFinite(e.x) || !Number.isFinite(e.y)) continue;
    // SOMET-286: `b` means "this attack was refused". It resolves to the
    // built-in def above WITHOUT consulting the library, so the cue survives
    // an empty or mis-migrated effect library — see BLOCK_EFFECT_DEF.
    const def = e.b === true ? BLOCK_EFFECT_DEF : (e.v && defs ? defs[e.v] : null);
    if (!def) continue;
    let nx = Number.isFinite(e.nx) ? e.nx : 0;
    let ny = Number.isFinite(e.ny) ? e.ny : 0;
    // A zero vector would make atan2 return 0 and point the swing due east.
    // Due south is the same fallback the server's vectorFromFacing uses.
    if (nx === 0 && ny === 0) { nx = 0; ny = 1; }
    list.push({
      def,
      x: e.x, y: e.y,
      nx, ny,
      reach: Number.isFinite(e.reach) ? e.reach : 0,
      arc: Number.isFinite(e.arc) ? e.arc : 0,
      hit: e.hit === true,
      // Slice C: the weapon's element, carried on impact descriptors so the
      // burst can be tinted. Copied through here rather than looked up at
      // draw time -- the client has no weapon catalog, by design.
      el: typeof e.el === "string" ? e.el : null,
      startedAt: nowMs,
    });
  }
  return list;
}

// Drop finished effects. Returns a NEW array (callers reassign) so an effect
// can never be mutated out from under an in-progress draw loop. Compares RAW
// elapsed time, never eased progress — easing is a display curve, and pruning
// off it would make an 'out' effect vanish early.
export function pruneEffects(list, nowMs) {
  if (!Array.isArray(list) || list.length === 0) return list || [];
  return list.filter((fx) => nowMs - fx.startedAt < duration(fx.def));
}

export function ease(t, mode) {
  if (mode === "out") return 1 - (1 - t) * (1 - t);
  if (mode === "in") return t * t;
  return t;                                    // 'linear' and anything unknown
}

// 0 at spawn -> 1 at expiry, clamped, then eased by the effect's own curve.
// This is what the geometry animates along (a wedge sweeping open).
export function effectProgress(fx, nowMs) {
  if (!fx) return 1;
  const d = duration(fx.def);
  const t = (nowMs - fx.startedAt) / d;
  return ease(t < 0 ? 0 : t > 1 ? 1 : t, fx.def && fx.def.ease);
}

// Opacity, on RAW time. Deliberately NOT eased: an eased alpha on a fast 'out'
// effect drops to near-zero almost immediately and the swing reads as a
// flicker rather than a sweep.
export function effectAlpha(fx, nowMs) {
  if (!fx || !fx.def || fx.def.fade === false) return 1;
  const t = (nowMs - fx.startedAt) / duration(fx.def);
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return 1 - c;
}

// A world direction (nx, ny) as the PARAMETRIC angle of the iso ground-plane
// ellipse.
//
// worldToScreen sends a world circle (R·cosθ, R·sinθ) to
//     x = X0 + R·√2·ISO_K·cos(θ + π/4)
//     y = Y0 + R·√2·ISO_K/2·sin(θ + π/4)
// (the same derivation blastScreenRadiusX documents), and canvas ellipse()
// draws (x + rx·cos φ, y + ry·sin φ). So φ = θ + π/4.
//
// Passing the raw world angle to ellipse() instead points every swing 45° off
// the direction the player aimed.
export function isoArcAngle(nx, ny) {
  return Math.atan2(ny, nx) + Math.PI / 4;
}

// ---------------------------------------------------------------------------
// Particles (slice C, SOMET-160).
// ---------------------------------------------------------------------------

// Hard ceiling on particles ALIVE across every effect on screen. The design
// names particles as the one real performance risk in this epic: 22 weapons
// bursting in a crowded neighbourhood. Eviction is oldest-first, so a burst of
// simultaneous impacts costs the OLDEST sparks rather than refusing the newest
// -- the newest are the ones the player is looking at.
export const MAX_LIVE_PARTICLES = 300;

// Deterministic scalar in [0,1) from two integers. A hash, NOT Math.random():
// the draw loop runs every frame, so a random call there would make the same
// effect jitter frame to frame, differ between clients watching the same
// fight, and be impossible to unit test. Seeding per (effect, index) makes
// particlesAt a pure function of its inputs.
function hash01(seed, i) {
  let h = (seed ^ (i * 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

// A stable per-effect seed. Derived from the arrival time and position rather
// than a counter so two effects in the same tick still differ, and so the same
// effect replayed from the same frame data looks identical.
export function effectSeed(fx) {
  const t = Math.floor(fx.startedAt || 0);
  const x = Math.floor(fx.x || 0);
  const y = Math.floor(fx.y || 0);
  return ((t * 73856093) ^ (x * 19349663) ^ (y * 83492791)) >>> 0;
}

// Particle offsets for an effect at raw progress `t` (0..1), in WORLD units
// relative to the effect's own origin. Pure: same (fx, t) always gives the
// same array, which is what makes the determinism test meaningful and what
// stops two clients disagreeing about a fight they both watched.
//
// Returns [] for an effect with no particles, so callers need no guard.
export function particlesAt(fx, t) {
  const def = fx && fx.def;
  const count = def ? Math.floor(Number(def.particle_count) || 0) : 0;
  if (count <= 0) return [];
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const seed = effectSeed(fx);
  const spread = Number(def.particle_spread);
  const speed = Number(def.particle_speed) || 0;
  const gravity = Number(def.particle_gravity) || 0;
  const life = (Number(def.particle_lifetime_ms) || 300) / 1000;
  const arc = Number.isFinite(spread) ? spread : Math.PI * 2;

  // Aim the cone along the effect's own direction when it is narrower than a
  // full circle; a full circle has no meaningful centre so the offset is
  // harmless there.
  const base = Math.atan2(Number(fx.ny) || 0, Number(fx.nx) || 0);
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = base + (hash01(seed, i) - 0.5) * arc;
    // Vary speed per particle so a burst does not read as a rigid ring.
    const v = speed * (0.5 + hash01(seed, i + 1013) * 0.5);
    const age = clamped * life;
    out.push({
      dx: Math.cos(a) * v * age,
      // +y is DOWN in world space, so gravity adds. Classic 1/2 g t^2.
      dy: Math.sin(a) * v * age + 0.5 * gravity * age * age,
      // Particles fade independently of the effect body, so a long-lived
      // spark can outlive the flash that spawned it.
      alpha: 1 - clamped,
    });
  }
  return out;
}

// Trim the live list so the total particle budget holds, oldest first.
// Returns a NEW array (same contract as pruneEffects) and leaves the input
// untouched, so a draw loop mid-iteration is never mutated out from under.
export function capParticles(list, max = MAX_LIVE_PARTICLES) {
  if (!Array.isArray(list) || list.length === 0) return list || [];
  let total = 0;
  for (const fx of list) total += (fx.def && Number(fx.def.particle_count)) || 0;
  if (total <= max) return list.slice();

  // Newest LAST in the list (addEffects pushes), so walk backwards keeping the
  // newest until the budget runs out.
  const kept = [];
  let used = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const n = (list[i].def && Number(list[i].def.particle_count)) || 0;
    if (n > 0 && used + n > max) continue;   // drop this one, keep looking for
    used += n;                               // cheaper ones behind it
    kept.push(list[i]);
  }
  return kept.reverse();
}
