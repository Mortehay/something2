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
    ...overrides,
  };
}

describe('validateEntityType', () => {
  it('rejects a negative Max HP (the confirmed live repro)', () => {
    const problem = validateEntityType(baseEntityForm({ max_hp: -50 }));
    expect(problem).toMatch(/max_hp/);
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

  it('accepts a normal, in-range entity form', () => {
    expect(validateEntityType(baseEntityForm())).toBeNull();
  });
});

describe('validateTileType', () => {
  it('rejects a negative speed', () => {
    expect(validateTileType({ name: 'lava', speed: -1 })).toMatch(/speed/i);
  });

  it('rejects a speed above 2', () => {
    expect(validateTileType({ name: 'ice', speed: 3 })).toMatch(/speed/i);
  });

  it('rejects a name over the 200-char server cap', () => {
    expect(validateTileType({ name: 'x'.repeat(MAX_CATALOG_NAME_LEN + 1), speed: 1 })).toMatch(/200/);
  });

  it('accepts a normal in-range tile form', () => {
    expect(validateTileType({ name: 'grass', speed: 1 })).toBeNull();
  });
});
