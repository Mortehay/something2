import { describe, it, expect } from 'vitest';
import { validateEntityType, validateTileType, MAX_CATALOG_NAME_LEN } from '../catalogValidation.js';

// F-025/SOMET-205: EntityTypesAdmin and TileTypesAdmin only checked that name
// was non-empty, so out-of-range numeric fields (a negative Max HP, a
// negative speed multiplier) reached the API with no client-side error.
// Confirmed live: editing the Wolf entity type's Max HP to -50 saved
// silently with no error anywhere.

function baseEntityForm(overrides = {}) {
  return {
    name: 'Wolf',
    color: '#ffffff',
    walkable: false,
    is_creature: true,
    spawn_tiles: [],
    chance: 0.1,
    strength: 10, dexterity: 10, constitution: 10, intelligence: 10, wisdom: 10, charisma: 10,
    hp: 12, max_hp: 12, hp_regen_rate: 1, mana: 0, max_mana: 0, mana_regen_rate: 0,
    display_width: 64, display_height: 64,
    place_order: 0,
    ...overrides,
  };
}

describe('validateEntityType', () => {
  it('rejects a negative Max HP (the confirmed live repro)', () => {
    const problem = validateEntityType(baseEntityForm({ max_hp: -50 }));
    expect(problem).toMatch(/max_hp/);
  });

  // The entity dialog reported "Update failed: display_width must be an integer
  // between 1 and 400" on Save Changes for entities nobody had ever given an
  // explicit size. display_width/display_height are OPTIONAL overrides of the
  // renderer default and are NULL for 301 of the 308 rows; the form loaded that
  // NULL as 0 and validated it as a plain non-negative stat, so 0 passed here
  // and was rejected by the API, which bounds the column to 1..400.
  it('accepts an unset display size, because unset is not zero', () => {
    expect(validateEntityType(baseEntityForm({ display_width: '', display_height: '' }))).toBeNull();
    expect(validateEntityType(baseEntityForm({ display_width: null, display_height: null }))).toBeNull();
  });

  it('rejects a zero display size instead of letting the API reject it', () => {
    // 0 is not a meaningful sprite size, and it is precisely the value the form
    // used to produce for an unset dimension.
    expect(validateEntityType(baseEntityForm({ display_width: 0 }))).toMatch(/display_width/);
  });

  it('rejects a display size outside the range the API enforces', () => {
    expect(validateEntityType(baseEntityForm({ display_height: 401 }))).toMatch(/display_height/);
    expect(validateEntityType(baseEntityForm({ display_width: 12.5 }))).toMatch(/display_width/);
  });

  it('rejects a chance above 1', () => {
    expect(validateEntityType(baseEntityForm({ chance: 1.5 }))).toMatch(/chance/i);
  });

  it('rejects a NaN stat (field cleared, then parseInt(""))', () => {
    expect(validateEntityType(baseEntityForm({ strength: NaN }))).toMatch(/strength/);
  });

  it('rejects a name over the 200-char server cap (mirrors F-043)', () => {
    const problem = validateEntityType(baseEntityForm({ name: 'x'.repeat(MAX_CATALOG_NAME_LEN + 1) }));
    expect(problem).toMatch(/200/);
  });

  it('rejects a negative place_order', () => {
    expect(validateEntityType(baseEntityForm({ place_order: -1 }))).toMatch(/place order/i);
  });

  it('rejects a non-integer place_order', () => {
    expect(validateEntityType(baseEntityForm({ place_order: 1.5 }))).toMatch(/place order/i);
  });

  it('accepts a normal, in-range entity form', () => {
    expect(validateEntityType(baseEntityForm())).toBeNull();
  });
});

describe('validateTileType', () => {
  it('rejects a negative speed', () => {
    expect(validateTileType({ name: 'lava', speed: -1, wall_height: 0, place_order: 0 })).toMatch(/speed/i);
  });

  it('rejects a speed above 2', () => {
    expect(validateTileType({ name: 'ice', speed: 3, wall_height: 0, place_order: 0 })).toMatch(/speed/i);
  });

  it('rejects a name over the 200-char server cap', () => {
    expect(validateTileType({ name: 'x'.repeat(MAX_CATALOG_NAME_LEN + 1), speed: 1, wall_height: 0, place_order: 0 })).toMatch(/200/);
  });

  it('rejects a negative wall_height', () => {
    expect(validateTileType({ name: 'wall', speed: 1, wall_height: -1, place_order: 0 })).toMatch(/wall height/i);
  });

  it('rejects a non-integer place_order', () => {
    expect(validateTileType({ name: 'wall', speed: 1, wall_height: 0, place_order: 1.5 })).toMatch(/place order/i);
  });

  it('accepts a normal in-range tile form', () => {
    expect(validateTileType({ name: 'grass', speed: 1, wall_height: 0, place_order: 0 })).toBeNull();
  });
});
