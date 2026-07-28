import { describe, it, expect } from 'vitest';
import { emptyBiomeForm, biomeToForm, biomeFormToPayload } from '../biomeForm.js';

const ROW = {
  id: 1, name: 'Meadow', terrain_tiles: ['grass', 'earth'], flora_types: ['bush'],
  creature_types: ['Slime'], palette: ['spring green', 'warm brown'],
  art_style: 'lush', exclusions: 'no snow', color: '#5aa84f',
};

describe('biomeForm', () => {
  it('an empty form has every field and no undefined', () => {
    const f = emptyBiomeForm();
    expect(Object.keys(f).sort()).toEqual([
      'art_style', 'color', 'creature_types', 'exclusions', 'flora_types',
      'name', 'palette', 'terrain_tiles',
    ]);
    for (const v of Object.values(f)) expect(v).toBeDefined();
  });

  it('round-trips a row through form and back to payload', () => {
    const payload = biomeFormToPayload(biomeToForm(ROW));
    expect(payload).toEqual({
      name: 'Meadow', terrain_tiles: ['grass', 'earth'], flora_types: ['bush'],
      creature_types: ['Slime'], palette: ['spring green', 'warm brown'],
      art_style: 'lush', exclusions: 'no snow', color: '#5aa84f',
    });
  });

  it('palette is edited as comma-separated text and split on save', () => {
    const f = { ...biomeToForm(ROW), palette: ' ochre , gold ,, burnt sienna ' };
    expect(biomeFormToPayload(f).palette).toEqual(['ochre', 'gold', 'burnt sienna']);
  });

  it('a row with null jsonb columns yields empty arrays, not crashes', () => {
    const f = biomeToForm({ name: 'X', terrain_tiles: null, flora_types: null, creature_types: null, palette: null });
    expect(biomeFormToPayload(f)).toEqual({
      name: 'X', terrain_tiles: [], flora_types: [], creature_types: [],
      palette: [], art_style: '', exclusions: '', color: '#888888',
    });
  });

  it('trims the name and drops blank multi-select entries', () => {
    const f = { ...emptyBiomeForm(), name: '  Mire  ', terrain_tiles: ['swamp', '', 'water'] };
    const p = biomeFormToPayload(f);
    expect(p.name).toBe('Mire');
    expect(p.terrain_tiles).toEqual(['swamp', 'water']);
  });
});
