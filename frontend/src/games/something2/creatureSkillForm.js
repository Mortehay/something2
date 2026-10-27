// Pure form <-> payload helpers for one creature_skills CATALOG row
// (SOMET-608, S6) -- mirrors abilityForm.js/behaviorForm.js's split for the
// same reason: frontend vitest runs in a node environment with no DOM, so
// this is the part of the admin page that can actually be unit-tested.

export const KINDS = ["slam", "nova", "summon", "projectile"];
// Mirrors creature_skills' own element CHECK (same list creature_abilities
// already uses). null (not in this list) is itself a legal value meaning
// "inherit the caster's own attack element".
export const ELEMENTS = ["physical", "arcane", "fire", "ice", "lightning"];

// Defaults for a BRAND-NEW skill, mirroring abilityForm.js's
// NEW_ABILITY_DEFAULTS rationale: a modal that defaulted every numeric to 0
// would produce a skill that cannot be cast (cooldown_ms 0 -> unbounded
// rate... except the DB CHECK forbids that, so it would 400 -- but
// confusingly, with no field highlighted) or that deals no damage and
// summons nothing. Applied only for a brand-new row (see isNewRow below);
// an EXISTING row's genuine 0 (radius 0 is legitimate for a `projectile`,
// whose own radius means hit-size, not an AoE) round-trips untouched.
const NEW_SKILL_DEFAULTS = {
  telegraph_ms: 500,
  cooldown_ms: 4000,
  radius: 80,
  range: 200,
  damage_mult: 1,
  summon_count: 1,
};
const NUMERIC = ["telegraph_ms", "cooldown_ms", "radius", "range", "damage_mult", "summon_count"];
const VFX_SLOTS = ["telegraph", "cast", "impact"];

export function creatureSkillToForm(row = {}) {
  const isNewRow = row.id == null;
  const vfx = row.vfx && typeof row.vfx === "object" ? row.vfx : {};
  const form = {
    id: row.id ?? null,
    name: row.name ?? "",
    kind: KINDS.includes(row.kind) ? row.kind : "slam",
    // null means "inherit the caster's own attack element" -- the empty
    // string is the form's spelling of that, matching abilityForm.js's
    // element field and behaviorForm.js's damage_override "".
    element: row.element ?? "",
    summon_entity: row.summon_entity ?? "",
    used_by: row.used_by ?? [],
  };
  for (const k of NUMERIC) form[k] = row[k] ?? (isNewRow ? NEW_SKILL_DEFAULTS[k] : 0);
  for (const slot of VFX_SLOTS) form[`vfx_${slot}`] = vfx[slot] ?? "";
  return form;
}

export function creatureSkillFormToPayload(form) {
  const payload = {
    name: form.name,
    kind: form.kind,
    element: form.element === "" || form.element == null ? null : form.element,
    summon_entity: form.summon_entity === "" || form.summon_entity == null ? null : form.summon_entity,
  };
  for (const k of NUMERIC) {
    const n = Number(form[k]);
    payload[k] = Number.isFinite(n) ? n : NEW_SKILL_DEFAULTS[k];
  }
  const vfx = {};
  for (const slot of VFX_SLOTS) {
    const v = form[`vfx_${slot}`];
    if (typeof v === "string" && v.trim()) vfx[slot] = v.trim();
  }
  payload.vfx = Object.keys(vfx).length > 0 ? vfx : null;
  return payload;
}

// Mirrors deleteBehaviorErrorMessage (behaviorForm.js) / the aura picker's
// equivalent -- used nowhere directly today (useCreatureSkills.js builds its
// own orphan message straight from referencing_behaviors inline), kept as a
// pure, independently-testable twin of that logic so a future caller (a
// delete-confirmation dialog on the catalog table, say) does not have to
// re-derive it from the hook.
export function deleteSkillErrorMessage(name, referencingBehaviors, fallback) {
  if (!referencingBehaviors || referencingBehaviors.length === 0) return fallback;
  const list = referencingBehaviors.map((b) => b.name).join(", ");
  return `Cannot delete "${name}": still bound by ${referencingBehaviors.length} behavior(s) (${list})`;
}
