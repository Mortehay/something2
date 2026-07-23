// Effect-name resolution. Pure (no DB, no world state).
//
// Names are resolved SERVER-SIDE and travel to the client as strings: the
// client must never need the weapon catalog or the binding rules to draw a
// frame. Everything else about an effect (shape, colour, timing) is looked up
// client-side from the vfx_effects library.

// The moment a binding key names. Only 'attack' is emitted in slice A;
// 'impact' is slice C, 'miss' slice B, 'trail' slice D.
const MOMENTS = ['attack', 'impact', 'miss', 'trail'];

// weapon.vfx is admin-editable jsonb with no FK to vfx_effects, so anything at
// all can be in there. Only a non-empty string is a name; every other shape
// degrades to null, which the client renders as nothing.
//
// SLICE B SEAM: the kind-level fallback goes here — when the binding misses,
// fall back to a default keyed on weapon.kind before returning null.
function resolveEffectName(weapon, moment) {
  if (!weapon) return null;
  const v = weapon.vfx;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const name = v[moment];
  return typeof name === 'string' && name.length > 0 ? name : null;
}

module.exports = { resolveEffectName, MOMENTS };
