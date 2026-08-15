// SOMET-326 slice A. Where an attack's visuals launch from, vertically, on the
// actor's body. Pure (no DB, no world state), like vfx.js beside it.
//
// THIS IS A RENDER ANCHOR AND NOTHING ELSE. The world is 2D -- projectiles
// carry only x,y and there is no Z axis (see projectiles.js's spawn) -- so
// nothing here may reach collision, hit detection or line-of-sight. A change
// that makes an origin move where a shot actually connects has left the slice.
//
// WHAT TRAVELS IS A PIXEL LIFT, NOT A NAME. Names are resolved server-side for
// the same reason effect names are (see vfx.js's header): the client must
// never need the weapon catalog. But there is a second, stronger reason here
// -- a projectile in flight has no actor attached to it, and its shooter can
// be dead or out of view by the time it lands, so the client would have no
// body height left to resolve a fraction against. The lift is therefore
// computed once, at launch, and carried -- exactly as `damage` and `vfxTrail`
// already are.

// Fraction of the actor's body height, measured UP from the feet.
//
// SOMET-329 moved these into the `attack_origins` catalog table. What is left
// here are the SEED DEFAULTS, kept for three reasons: they are what a world
// built before the catalog loads uses, they are what the pure unit tests
// exercise without a database, and they are the fallback if the table is ever
// empty -- an empty catalog must not silently drop every attack to the ground.
//
// configureAttackOrigins() below replaces them with the live rows, so an admin
// editing height_fraction actually moves where attacks launch from. The
// migration seeds exactly these values, so that swap is a no-op on day one.
const DEFAULT_ORIGIN_FRACTIONS = { feet: 0, middle: 0.5, head: 0.85 };

let ORIGIN_FRACTIONS = { ...DEFAULT_ORIGIN_FRACTIONS };

// Called once per catalog load (server.js, beside loadItemTypes). Module-level
// rather than threaded through every call site because the catalog is global
// by construction -- one database, one set of origins, shared by every world --
// and attackLift is reached from three unrelated files (world.js, creatures.js,
// projectiles.js) that would otherwise all have to carry it.
//
// An empty or unusable map is IGNORED rather than applied: losing the table
// must degrade to the seeded defaults, never to "no origins exist", which
// bodyLift would resolve as a 0 lift -- every attack on the ground.
function configureAttackOrigins(fractions) {
  if (!fractions) return ORIGIN_FRACTIONS;
  const entries = fractions instanceof Map ? [...fractions.entries()] : Object.entries(fractions);
  const next = {};
  for (const [name, value] of entries) {
    const f = Number(value);
    if (typeof name === 'string' && name && Number.isFinite(f) && f >= 0 && f <= 1) next[name] = f;
  }
  if (Object.keys(next).length === 0) return ORIGIN_FRACTIONS;
  ORIGIN_FRACTIONS = next;
  return ORIGIN_FRACTIONS;
}

// Test seam: restores the seeded defaults so one test's catalog cannot leak
// into the next. Never called by production code.
function resetAttackOrigins() {
  ORIGIN_FRACTIONS = { ...DEFAULT_ORIGIN_FRACTIONS };
  return ORIGIN_FRACTIONS;
}

// Kind-level defaults, resolved binding -> kind default -> fallback, the same
// shape vfx.js's KIND_DEFAULTS uses.
//
// Both kinds default to `middle` deliberately: 'middle' x a 64px player is a
// 32px lift, which is byte-for-byte what every attack rendered at before this
// slice. So an unauthored weapon looks EXACTLY as it did, and the only thing
// that changes on day one is that the lift now tracks the actor's real height
// instead of the tile's -- which is the bug.
const KIND_DEFAULTS = { melee: 'middle', projectile: 'middle' };

// For anything with no kind at all (a creature ability, an impact on a
// target). Not folded into KIND_DEFAULTS: a missing kind and an unrecognised
// kind are the same case here, and a lookup miss must not read as `feet`.
const FALLBACK_ORIGIN = 'middle';

// The body height assumed when an actor's own height is unusable. 64 is the
// player box (world.js's PLAYER_W/PLAYER_H), i.e. the size that made the old
// hardcoded 32px lift look correct in the first place.
const FALLBACK_BODY_HEIGHT = 64;

// weapon.attack_origin is admin-authored text. The DB CHECK constrains it, but
// this function is also reached by creature abilities and by rows loaded from
// a catalog that predates the column, so anything at all can arrive -- every
// unrecognised shape degrades to the kind default, then to `middle`, never to
// a throw and never to an invisible attack.
function resolveAttackOrigin(source) {
  if (source) {
    const authored = source.attack_origin;
    if (typeof authored === 'string' && ORIGIN_FRACTIONS[authored] !== undefined) {
      return authored;
    }
    if (typeof source.kind === 'string' && KIND_DEFAULTS[source.kind]) {
      return KIND_DEFAULTS[source.kind];
    }
  }
  return FALLBACK_ORIGIN;
}

// The lift, in screen pixels, for `origin` on a body `bodyHeight` tall.
//
// Screen pixels and world units are the same number for a body height: sprites
// are drawn at their world box size, unscaled (RenderSystem's drawCreature does
// `drawImage(img, drawX, drawY, w, h)` with `h = obj.height`). If that ever
// stops being true, this is the one place that has to learn the scale factor.
//
// Rounded because it is consumed as a screen-space offset; a fractional lift
// buys nothing and makes wire frames noisier.
function bodyLift(bodyHeight, origin) {
  const h = Number(bodyHeight);
  const height = Number.isFinite(h) && h > 0 ? h : FALLBACK_BODY_HEIGHT;
  // Three rungs, because the fractions are admin data since SOMET-329 and an
  // admin can delete a row: the named origin, then `middle`, then the SEEDED
  // middle. Without that last rung a catalog missing `middle` would multiply
  // by undefined and put NaN on the wire, which the client reads as a junk
  // anchor -- every attack silently back on the legacy tile lift.
  const fraction = ORIGIN_FRACTIONS[origin] ?? ORIGIN_FRACTIONS[FALLBACK_ORIGIN]
    ?? DEFAULT_ORIGIN_FRACTIONS[FALLBACK_ORIGIN];
  return Math.round(height * fraction);
}

// The lift for an attack made with `weapon` by an actor `bodyHeight` tall.
// This is the call site that matters: world.js's attack(), the creature tick,
// and projectiles.spawn all go through it so the three can never disagree
// about where a given weapon launches from.
function attackLift(weapon, bodyHeight) {
  return bodyLift(bodyHeight, resolveAttackOrigin(weapon));
}

module.exports = {
  DEFAULT_ORIGIN_FRACTIONS, KIND_DEFAULTS, FALLBACK_ORIGIN, FALLBACK_BODY_HEIGHT,
  resolveAttackOrigin, bodyLift, attackLift,
  configureAttackOrigins, resetAttackOrigins,
  // A getter, not the object: ORIGIN_FRACTIONS is reassigned by
  // configureAttackOrigins, and a destructured export would hand callers a
  // snapshot of whatever it was at require() time.
  originFractions: () => ORIGIN_FRACTIONS,
};
