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

// Fraction of the actor's body height, measured UP from the feet. These move
// into the `attack_origins` catalog table in slice B (SOMET-329); the column
// already stores names rather than numbers so that becomes a constraint swap.
const ORIGIN_FRACTIONS = { feet: 0, middle: 0.5, head: 0.85 };

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
  const fraction = ORIGIN_FRACTIONS[origin];
  return Math.round(height * (fraction === undefined ? ORIGIN_FRACTIONS[FALLBACK_ORIGIN] : fraction));
}

// The lift for an attack made with `weapon` by an actor `bodyHeight` tall.
// This is the call site that matters: world.js's attack(), the creature tick,
// and projectiles.spawn all go through it so the three can never disagree
// about where a given weapon launches from.
function attackLift(weapon, bodyHeight) {
  return bodyLift(bodyHeight, resolveAttackOrigin(weapon));
}

module.exports = {
  ORIGIN_FRACTIONS, KIND_DEFAULTS, FALLBACK_ORIGIN, FALLBACK_BODY_HEIGHT,
  resolveAttackOrigin, bodyLift, attackLift,
};
