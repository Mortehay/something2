// Effect-name resolution. Pure (no DB, no world state).
//
// Names are resolved SERVER-SIDE and travel to the client as strings: the
// client must never need the weapon catalog or the binding rules to draw a
// frame. Everything else about an effect (shape, colour, timing) is looked up
// client-side from the vfx_effects library.

// The moment a binding key names. 'attack' and 'miss' are emitted from slice
// B; 'impact' is slice C, 'trail' slice D.
const MOMENTS = ['attack', 'impact', 'miss', 'trail'];

// Kind-level defaults (slice B). Resolution is: binding -> kind default ->
// nothing.
//
// This exists so a weapon added later in the Items admin with NO binding
// renders plain-but-visible rather than invisible -- invisible would look
// exactly like the bug this whole epic was filed to fix, which is the worst
// possible failure mode for a fallback to have.
//
// Keyed [moment][kind] rather than one default per kind: falling back from a
// missing 'miss' binding to the ATTACK effect would draw a hit on a whiff and
// destroy the very distinction slice B adds. A moment with no default for a
// kind resolves to nothing, deliberately.
// `creature` is a kind alongside the two item_types kinds, per the design:
// "Defaults are keyed on item_types.kind (melee -> generic slash, projectile
// -> generic bolt) and on is_creature for entities." Creature contact damage
// was previously an invisible HP drain -- the default is what stops that
// being the case for any creature nobody has authored a binding for.
const KIND_DEFAULTS = {
  attack: { melee: 'generic_slash', projectile: 'generic_bolt', creature: 'generic_slash' },
  miss: { melee: 'generic_whiff', projectile: 'generic_whiff' },
  impact: { creature: 'spark_hit' },
  trail: {},
};

// weapon.vfx is admin-editable jsonb with no FK to vfx_effects, so anything at
// all can be in there. Only a non-empty string is a name; every other shape
// degrades to the kind default, and then to null, which the client renders as
// nothing.
//
// An unresolvable NAME (a binding pointing at a row someone renamed) is not
// detectable here -- this function does not hold the library -- and is handled
// on the client, which drops an event whose name it cannot look up. That is
// the accepted cost of jsonb bindings with no referential integrity; the admin
// screen's dropdown (slice E) is the other half of the mitigation.
function resolveEffectName(weapon, moment) {
  if (!weapon) return null;
  const v = weapon.vfx;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const name = v[moment];
    if (typeof name === 'string' && name.length > 0) return name;
  }
  const byKind = KIND_DEFAULTS[moment];
  if (byKind && typeof weapon.kind === 'string') {
    const fallback = byKind[weapon.kind];
    if (fallback) return fallback;
  }
  return null;
}

// Which moment a swing should play. The server already knows whether the
// attack connected (`landed`), so the client is never asked to decide -- it
// receives one resolved name and draws it.
function momentForAttack(landed) {
  return landed ? 'attack' : 'miss';
}

module.exports = {
  resolveEffectName, momentForAttack, MOMENTS, KIND_DEFAULTS,
};
