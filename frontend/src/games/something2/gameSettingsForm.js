// Pure field descriptions and input parsing for the game-settings editor.
// Kept out of the component for the same reason vfxForm.js is: vitest runs
// this project in a plain node env, so a page-level component cannot be
// rendered, and every rule worth testing has to live somewhere renderable.
//
// The server re-validates all of this (backend/src/services/gameSettings.js).
// This copy exists to give the admin an inline message instead of a toast
// from a 400, NOT as the authority.

export const SETTING_FIELDS = [
  {
    key: 'passive_points_per_level',
    label: 'Passive points per level',
    kind: 'integer',
    min: 0,
    hint: 'Points granted on each level-up. Applies to future level-ups only.',
  },
  {
    key: 'ground_item_ttl_seconds',
    label: 'Ground item lifetime (seconds)',
    kind: 'integer',
    min: 1,
    hint: 'How long dropped loot lies on the ground before it puffs away.',
  },
  {
    key: 'respec_base_gold',
    label: 'Respec cost per level (gold)',
    kind: 'integer',
    min: 0,
    hint: 'A respec costs this many gold multiplied by the character level.',
  },
  {
    key: 'rarity_weights',
    label: 'Rarity weights by item level',
    kind: 'json',
    hint: 'Anchor rows interpolated by item level. Weights need not sum to 100 — they are normalised before rolling.',
  },
];

const BY_KEY = new Map(SETTING_FIELDS.map((f) => [f.key, f]));

// -> { value } on success, { error } on failure. Never both.
export function parseSettingInput(key, raw) {
  const field = BY_KEY.get(key);
  if (!field) return { error: `unknown setting: ${key}` };

  if (field.kind === 'integer') {
    const trimmed = String(raw ?? '').trim();
    if (!/^-?\d+$/.test(trimmed)) return { error: `${field.label} must be a whole number` };
    const value = Number(trimmed);
    if (value < field.min) return { error: `${field.label} must be ${field.min} or more` };
    return { value };
  }

  try {
    return { value: JSON.parse(String(raw ?? '')) };
  } catch {
    return { error: `${field.label} is not valid JSON` };
  }
}
