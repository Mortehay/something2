// Pure form <-> payload helpers for one ability row, nested under a
// behaviour in CreatureBehaviorsAdmin (SOMET-253 Task 3). Split out the same
// way behaviorForm.js is: frontend vitest runs in a node environment with no
// DOM, so this is the part that can actually be tested.

// Mirrors the element CHECK constraint in migration 1714440083000 and
// services/creatureBehaviors.js's ELEMENTS. `null` (not in this list) is
// itself a legal value meaning "inherit the creature type's own element" --
// see abilityToForm/abilityFormToPayload below.
export const ELEMENTS = ["physical", "fire", "ice", "lightning"];

// Defaults for a BRAND-NEW ability, mirroring the Line profile's attack
// rather than 0. P2a's final review caught an Add-Behavior modal that
// defaulted every numeric to 0, which produced a creature that never moved,
// never aggroed and never attacked -- no error, nothing logged. The same trap
// here would give attack_range 0 (never attacks) or attack_cooldown 0
// (unbounded rate of fire). Applied ONLY when the row has no id (see
// isNewRow below); an EXISTING row's stored value -- including a genuine 0,
// which damage_mult/knockback/projectile_speed/projectile_radius can all
// legitimately be -- must still round-trip untouched.
const NEW_ABILITY_DEFAULTS = {
  attack_range: 60,
  attack_cooldown: 1,
  projectile_speed: 0,
  projectile_radius: 0,
  damage_mult: 1,
  knockback: 0,
};

const NUMERIC = ["attack_range", "attack_cooldown", "projectile_speed", "projectile_radius"];

export function abilityToForm(row = {}) {
  const isNewRow = row.id == null;
  const form = {
    id: row.id ?? null,
    name: row.name ?? "",
    attack_kind: row.attack_kind ?? "melee",
    // null means "use the creature type's own attack_element" -- the empty
    // string is the form's spelling of that, matching damage_override's "" in
    // behaviorForm.js.
    element: row.element ?? "",
    // damage_mult and knockback use an explicit isNewRow default of their
    // own (not folded into NUMERIC's loop below) because 0 is a legitimate
    // EXISTING value for both -- damage_mult 0 is a pure status-rider
    // ability, knockback 0 is every non-Brute profile -- and must round-trip
    // untouched, while a brand-new row should still default to 1 / 0
    // respectively, not to the same 0 NUMERIC's `?? 0` would give.
    damage_mult: row.damage_mult ?? (isNewRow ? NEW_ABILITY_DEFAULTS.damage_mult : 0),
    knockback: row.knockback ?? (isNewRow ? NEW_ABILITY_DEFAULTS.knockback : 0),
  };
  for (const k of NUMERIC) form[k] = row[k] ?? (isNewRow ? NEW_ABILITY_DEFAULTS[k] : 0);
  return form;
}

export function abilityFormToPayload(form, index) {
  // slot is IMPLIED BY POSITION -- the editor reorders by drag, and the API
  // renumbers 1..n anyway. Never read a slot out of the form.
  const payload = {
    slot: index + 1,
    name: form.name,
    attack_kind: form.attack_kind,
    element: form.element === "" || form.element == null ? null : form.element,
  };
  for (const k of NUMERIC) payload[k] = Number(form[k]) || 0;
  // damage_mult and knockback use Number() with an explicit Number.isFinite
  // guard, NOT `Number(x) || 0` -- a damage_mult of 0 is a legitimate
  // pure-rider ability and `|| 0` would silently rewrite a deliberate 0 as 0
  // (harmless) while a hypothetical `|| 1` default elsewhere would rewrite it
  // as 1 (not harmless). Being explicit here keeps the same guard shape for
  // both fields regardless of which fallback either one nominally needs.
  for (const k of ["damage_mult", "knockback"]) {
    const n = Number(form[k]);
    payload[k] = Number.isFinite(n) ? n : NEW_ABILITY_DEFAULTS[k];
  }
  return payload;
}
