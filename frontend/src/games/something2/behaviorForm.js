// Pure form <-> payload helpers for CreatureBehaviorsAdmin. Split out of the
// component because frontend vitest runs in a node environment with no DOM:
// this is the part that can actually be tested.

// Mirrors ATTACK_KINDS / CHASE_STYLES in
// backend/src/services/creatureBehaviors.js and the CHECK constraints in
// migration 1714440080000. Three copies is deliberate -- see the note in the
// backend module.
export const ATTACK_KINDS = ["melee", "ranged", "cast"];
export const CHASE_STYLES = ["charge", "kite", "skirmish", "hold", "ambush", "guard"];

const NUMERIC = [
  "attack_range", "attack_cooldown", "projectile_speed", "projectile_radius",
  "aggro_radius", "leash_radius", "preferred_range", "move_speed_mult",
];

// Defaults for a BRAND-NEW profile, mirroring the Line profile (today's
// baseline hostile creature) rather than 0. A modal that opens with every
// numeric at 0 lets an admin type a name, pick melee/charge and save a
// creature that never moves (move_speed_mult 0), never aggroes
// (aggro_radius/leash_radius 0) and never attacks (attack_range/
// attack_cooldown 0) -- no error, nothing logged, the exact silent-inertness
// class this sub-project exists to remove. Applied ONLY when the row has no
// id (see isNewRow below); an EXISTING row's stored value -- including a
// genuine 0, which every melee profile has for projectile_speed/
// projectile_radius -- must still round-trip untouched.
const NEW_ROW_DEFAULTS = {
  attack_range: 60,
  attack_cooldown: 1,
  projectile_speed: 0,
  projectile_radius: 0,
  aggro_radius: 400,
  leash_radius: 800,
  preferred_range: 0,
  move_speed_mult: 1,
};

export function behaviorToForm(row = {}) {
  const isNewRow = row.id == null;
  const form = {
    id: row.id ?? null,
    name: row.name ?? "",
    attack_kind: row.attack_kind ?? "melee",
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
    attack_kind: form.attack_kind,
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
