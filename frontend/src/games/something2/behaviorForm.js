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

export function behaviorToForm(row = {}) {
  const form = {
    id: row.id ?? null,
    name: row.name ?? "",
    attack_kind: row.attack_kind ?? "melee",
    chase_style: row.chase_style ?? "charge",
    // null means "use the creature's own damage". 0 is a real override and
    // must survive the round trip, so this is an explicit null check.
    damage_override: row.damage_override == null ? "" : row.damage_override,
  };
  for (const k of NUMERIC) form[k] = row[k] ?? 0;
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
