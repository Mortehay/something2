// Pure form <-> payload helpers for CreatureBehaviorsAdmin. Split out of the
// component because frontend vitest runs in a node environment with no DOM:
// this is the part that can actually be tested.

// Mirrors ATTACK_KINDS / CHASE_STYLES in
// backend/src/services/creatureBehaviors.js and the CHECK constraints in
// migrations 1714440080000/1714440083000. Three copies is deliberate -- see
// the note in the backend module. ATTACK_KINDS lives here rather than in
// abilityForm.js because CHASE_STYLES does too and the two value sets are
// consumed together by the same admin form; attack_kind itself is an
// ability-level field as of SOMET-253 Task 3, not a behaviour-level one.
//
// SOMET-290: `skittish` was added to the backend list and the CHECK constraint
// and NOT to this one, which is the failure mode a deliberate duplicate has to
// be defended against by a test rather than by a comment. A style missing here
// does not render as a missing option -- CreatureBehaviorsAdmin builds the
// Chase Style <select> from this array, so the Skittish profile opened BLANK
// (a controlled value matching no option), and the first touch of the dropdown
// rewrote chase_style to a listed value. The PUT is accepted, because the API
// validates against the backend list, and every skittish creature in the world
// silently becomes a charger. behaviorForm.test.js now asserts this array
// AGAINST the backend module's own, so the next style cannot drift silently.
export const ATTACK_KINDS = ["melee", "ranged", "cast"];
export const CHASE_STYLES = ["charge", "kite", "skirmish", "hold", "ambush", "guard", "skittish"];

// SOMET-253 Task 3: attack_range/attack_cooldown/projectile_speed/
// projectile_radius and attack_kind moved to abilityForm.js -- the attack is
// nested under the behaviour as an `abilities` array now, not flat fields
// here. This module covers the movement/aggro half only.
// SOMET-253 Task 8: aura_radius/aura_damage_mult/aura_defense_mult/
// aura_speed_mult and gold_min/gold_max, added to creature_behaviors by
// Task 4's migration 1714440085000. This mirrors that migration's CHECK
// constraint exactly (aura_radius/gold_min >= 0, the three aura multipliers
// and gold_max > their floor).
const NUMERIC = [
  "aggro_radius", "leash_radius", "preferred_range", "move_speed_mult",
  "aura_radius", "aura_damage_mult", "aura_defense_mult", "aura_speed_mult",
  "gold_min", "gold_max",
];

// Defaults for a BRAND-NEW profile, mirroring the Line profile (today's
// baseline hostile creature) rather than 0. A modal that opens with every
// numeric at 0 lets an admin type a name, pick charge and save a creature
// that never moves (move_speed_mult 0) and never aggroes (aggro_radius/
// leash_radius 0) -- no error, nothing logged, the exact silent-inertness
// class this sub-project exists to remove. Applied ONLY when the row has no
// id (see isNewRow below); an EXISTING row's stored value -- including a
// genuine 0, which is legitimate for preferred_range -- must still round-trip
// untouched.
//
// The three aura multipliers default to 1 (neutral), NOT 0, for the exact
// same reason move_speed_mult does: aura_damage_mult/aura_defense_mult/
// aura_speed_mult of 0 would make every creature the aura touches deal, take,
// or move at zero the instant a leader stands near them -- silently, since
// nothing here or in behaviorFieldError treats 0 as invalid input, only as a
// bad DEFAULT. aura_radius correctly defaults to 0 ("not a leader"), matching
// eleven of the twelve seeded profiles; gold_min/gold_max default to 0 (no
// loot) since not every new profile needs a gold range.
const NEW_ROW_DEFAULTS = {
  aggro_radius: 400,
  leash_radius: 800,
  preferred_range: 0,
  move_speed_mult: 1,
  aura_radius: 0,
  aura_damage_mult: 1,
  aura_defense_mult: 1,
  aura_speed_mult: 1,
  gold_min: 0,
  gold_max: 0,
};

export function behaviorToForm(row = {}) {
  const isNewRow = row.id == null;
  const form = {
    id: row.id ?? null,
    name: row.name ?? "",
    chase_style: row.chase_style ?? "charge",
    // null means "use the creature's own damage". 0 is a real override and
    // must survive the round trip, so this is an explicit null check.
    damage_override: row.damage_override == null ? "" : row.damage_override,
  };
  for (const k of NUMERIC) form[k] = row[k] ?? (isNewRow ? NEW_ROW_DEFAULTS[k] : 0);
  return form;
}

export function behaviorFormToPayload(form) {
  const payload = {
    name: form.name,
    chase_style: form.chase_style,
    damage_override: form.damage_override === "" || form.damage_override == null
      ? null : Number(form.damage_override),
  };
  for (const k of NUMERIC) payload[k] = Number(form[k]) || 0;
  return payload;
}

// DELETE /api/creature-behaviors/:id returns 409 with
// `referencing_entity_types: [{id, name}, ...]` when a creature type still
// points at the profile -- see backend/src/index.js's delete handler. Names
// the blockers instead of leaving the admin to hunt through the Entities
// table row by row. Capped so a profile used by twenty creature types
// doesn't produce an unreadable toast.
export function formatReferencingEntityTypes(refs, max = 3) {
  const names = (refs || []).map((r) => r.name);
  if (names.length === 0) return "";
  if (names.length <= max) return names.join(", ");
  const shown = names.slice(0, max).join(", ");
  const rest = names.length - max;
  return `${shown} and ${rest} more`;
}

// The full delete-failure toast text. `behaviorName` is the profile the
// admin tried to delete (from the row, not the error body -- the 409 payload
// only names what's blocking, not what was being deleted). Falls back to a
// generic message when there is nothing to name (a network error, a 500,
// etc.), so this is safe to call unconditionally in the delete error path.
export function deleteBehaviorErrorMessage(behaviorName, refs, fallback) {
  if (!refs || refs.length === 0) return fallback;
  const subject = behaviorName ? `"${behaviorName}"` : "this profile";
  return `Cannot delete ${subject}: still used by ${formatReferencingEntityTypes(refs)}`;
}
