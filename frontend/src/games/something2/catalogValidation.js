// Client-side validation for EntityTypesAdmin and TileTypesAdmin.
//
// F-025/SOMET-205: both forms only checked that `name` was non-empty before
// submitting. Every numeric stat (hp, max_hp, mana, strength, chance, speed,
// ...) had no client-side bound, and the backend for these two catalogs has
// none either (only ItemTypesAdmin mirrors its backend's validateItemType()).
// A negative/nonsensical stat therefore saved silently with no error shown
// anywhere. This adds the same validate-before-submit pattern ItemTypesAdmin
// already established (see itemTypeForm.js's validateClient), scoped to what
// the fields' own declared shape already implies (chance is a 0-1 fraction,
// speed is a 0-2 multiplier, every stat is a non-negative count) plus the
// 200-char name cap the backend added in F-043 (index.js's
// MAX_CATALOG_NAME_LEN), so the client rejects what the server will too
// instead of inventing a different limit.
export const MAX_CATALOG_NAME_LEN = 200;

function isNonNegFinite(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

function isNonNegInt(n) {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

const ENTITY_STAT_FIELDS = [
  'strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma',
  'hp', 'max_hp', 'hp_regen_rate', 'mana', 'max_mana', 'mana_regen_rate',
  'display_width', 'display_height',
];

export function validateEntityType(f) {
  if (!f.name.trim()) return 'Name is required';
  if (f.name.length > MAX_CATALOG_NAME_LEN) return `name must be ${MAX_CATALOG_NAME_LEN} characters or fewer`;
  if (!isNonNegFinite(f.chance) || f.chance > 1) return 'Spawn Chance must be a number between 0 and 1';
  for (const key of ENTITY_STAT_FIELDS) {
    if (!isNonNegFinite(f[key])) return `${key} must be a non-negative number`;
  }
  if (!isNonNegInt(f.place_order)) return 'Place Order must be a non-negative integer';
  return null;
}

export function validateTileType(f) {
  if (!f.name.trim()) return 'Name is required';
  if (f.name.length > MAX_CATALOG_NAME_LEN) return `name must be ${MAX_CATALOG_NAME_LEN} characters or fewer`;
  if (!isNonNegFinite(f.speed) || f.speed > 2) return 'Speed must be a number between 0 and 2';
  if (!isNonNegInt(f.wall_height)) return 'Wall Height must be a non-negative integer';
  if (!isNonNegInt(f.place_order)) return 'Place Order must be a non-negative integer';
  return null;
}
