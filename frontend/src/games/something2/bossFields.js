// SOMET-603: pure rules behind the entity editor's boss fields, kept out of
// EntityTypesAdmin.jsx so a test can reach them (that suite has no DOM).
// The server re-validates every one of these (index.js entityTypeFieldError).
export const BOSS_TIERS = ["world", "dungeon_end", "dungeon_elite"];
export const BOSS_TIER_LABELS = {
  world: "World boss",
  dungeon_end: "Dungeon boss (End)",
  dungeon_elite: "Dungeon mini-boss (Elite)",
};
// The seeded `elements` table. The server validates against the live table.
export const ENTITY_ELEMENTS = ["physical", "arcane", "fire", "ice", "lightning"];
export const BOSS_FORM_DEFAULTS = Object.freeze({
  boss_tier: "", element: "", hitbox_size: "", xp_reward: "", base_damage: "",
});

const blankToNull = (v) => (v === "" || v == null || Number.isNaN(v) ? null : v);

export function bossFieldsFromEntity(entity) {
  return {
    boss_tier: entity?.boss_tier ?? "",
    element: entity?.element ?? "",
    hitbox_size: entity?.hitbox_size ?? "",
    xp_reward: entity?.xp_reward ?? "",
    base_damage: entity?.base_damage ?? "",
  };
}

// Every key, always: the PUT treats an absent key as "leave alone" and null
// as "clear", and an emptied input means clear.
export function bossFieldsPayload(f) {
  return {
    boss_tier: blankToNull(f.boss_tier),
    element: blankToNull(f.element),
    hitbox_size: blankToNull(f.hitbox_size),
    xp_reward: blankToNull(f.xp_reward),
    base_damage: blankToNull(f.base_damage),
  };
}

export function bossFieldError(f) {
  const hb = blankToNull(f.hitbox_size);
  if (hb != null && (!Number.isInteger(hb) || hb < 1 || hb > 400)) return "Hitbox Size must be an integer between 1 and 400";
  const xp = blankToNull(f.xp_reward);
  if (xp != null && (!Number.isInteger(xp) || xp < 0)) return "XP Reward must be a non-negative integer";
  const dmg = blankToNull(f.base_damage);
  if (dmg != null && (!Number.isFinite(dmg) || dmg < 0)) return "Base Damage must be a non-negative number";
  return null;
}

export function bossBadgeLabel(entity) {
  return (entity && BOSS_TIER_LABELS[entity.boss_tier]) || null;
}
