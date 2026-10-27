// SOMET-603: pure rules behind the entity editor's boss fields, kept out of
// EntityTypesAdmin.jsx so a test can reach them (that suite has no DOM).
// The server re-validates every one of these (index.js entityTypeFieldError).
export const BOSS_TIERS = ["world", "dungeon_end", "dungeon_elite", "miniboss"];
export const BOSS_TIER_LABELS = {
  world: "World boss",
  dungeon_end: "Dungeon boss (End)",
  dungeon_elite: "Dungeon mini-boss (Elite)",
  miniboss: "Miniboss",
};
import { ELEMENTS } from "./abilityForm.js";

// ONE frontend element list (abilityForm.js), pinned to the backend's
// creatureBehaviors.ELEMENTS by __tests__/elementLists.test.js.
export const ENTITY_ELEMENTS = ELEMENTS;
// Mirrors MAX_ENTITY_DISPLAY_PX in backend/src/index.js (pinned by the same test).
export const MAX_HITBOX_PX = 400;
// SOMET-611 (S10, spec §3.7): the four nullable loot override columns.
// RARITIES mirrors backend/src/authority/rarity.js's own constant (ascending
// white < blue < yellow < foxy) -- not imported, since the frontend has no
// access to backend source; __tests__/bossFields.test.js pins the two lists
// (and MAX_LOOT_ROLLS) against the backend source.
export const LOOT_RARITIES = ["white", "blue", "yellow", "foxy"];
// Mirrors MAX_LOOT_ROLLS in backend/src/authority/bossLoot.js.
export const MAX_LOOT_ROLLS = 20;
// The boss tiers whose loot the four loot_* columns actually drive
// (bossLoot.js's TIER_LOOT_DEFAULTS). A miniboss has its own drop path
// (S12), so the form hides the fields there rather than offering overrides
// that would silently do nothing.
export const LOOT_TIERS = ["world", "dungeon_end", "dungeon_elite"];
// loot_chest is tri-state (NULL = tier default, true, false) -- a plain
// checkbox has no way to represent "unset", so the form field is a string
// ("", "true", "false") converted at the payload/hydration boundary, same
// shape blankToNull already gives every other nullable field here.
export const BOSS_FORM_DEFAULTS = Object.freeze({
  boss_tier: "", element: "", hitbox_size: "", xp_reward: "", base_damage: "",
  loot_rolls: "", loot_min_rarity: "", loot_rarity_bias: "", loot_chest: "",
});

const blankToNull = (v) => (v === "" || v == null || Number.isNaN(v) ? null : v);

export function bossFieldsFromEntity(entity) {
  return {
    boss_tier: entity?.boss_tier ?? "",
    element: entity?.element ?? "",
    hitbox_size: entity?.hitbox_size ?? "",
    xp_reward: entity?.xp_reward ?? "",
    base_damage: entity?.base_damage ?? "",
    loot_rolls: entity?.loot_rolls ?? "",
    loot_min_rarity: entity?.loot_min_rarity ?? "",
    // NUMERIC column: pg returns it as a string ("0.5"); coerce here or
    // bossFieldError's Number.isFinite (and the server's typeof check)
    // rejects every later save of a row that has a bias set.
    loot_rarity_bias: entity?.loot_rarity_bias == null ? "" : Number(entity.loot_rarity_bias),
    loot_chest: entity?.loot_chest == null ? "" : String(entity.loot_chest),
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
    loot_rolls: blankToNull(f.loot_rolls),
    loot_min_rarity: blankToNull(f.loot_min_rarity),
    loot_rarity_bias: blankToNull(f.loot_rarity_bias),
    loot_chest: f.loot_chest === "" ? null : f.loot_chest === "true",
  };
}

export function bossFieldError(f) {
  const hb = blankToNull(f.hitbox_size);
  if (hb != null && (!Number.isInteger(hb) || hb < 1 || hb > MAX_HITBOX_PX)) return `Hitbox Size must be an integer between 1 and ${MAX_HITBOX_PX}`;
  const xp = blankToNull(f.xp_reward);
  if (xp != null && (!Number.isInteger(xp) || xp < 0)) return "XP Reward must be a non-negative integer";
  const dmg = blankToNull(f.base_damage);
  if (dmg != null && (!Number.isFinite(dmg) || dmg < 0)) return "Base Damage must be a non-negative number";
  const rolls = blankToNull(f.loot_rolls);
  if (rolls != null && (!Number.isInteger(rolls) || rolls < 0 || rolls > MAX_LOOT_ROLLS)) {
    return `Loot Rolls must be an integer between 0 and ${MAX_LOOT_ROLLS}`;
  }
  const minRarity = blankToNull(f.loot_min_rarity);
  if (minRarity != null && !LOOT_RARITIES.includes(minRarity)) return "Loot Min Rarity must be one of white/blue/yellow/foxy";
  const bias = blankToNull(f.loot_rarity_bias);
  if (bias != null && (!Number.isFinite(bias) || bias < 0 || bias > 0.9)) return "Loot Rarity Bias must be a number between 0 and 0.9";
  return null;
}

export function bossBadgeLabel(entity) {
  return (entity && BOSS_TIER_LABELS[entity.boss_tier]) || null;
}
