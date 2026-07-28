import { describe, it, expect } from 'vitest';
import { emptyBiomeForm, biomeToForm, biomeFormToPayload, orderBiomeNames } from '../biomeForm.js';

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

// worlds.biomes is order-sensitive on the backend (biome i owns noise band
// i, and the update route diffs it with an order-sensitive JSON.stringify).
// A world's selected biomes are tracked client-side as a Set, and a JS Set's
// iteration order moves an entry to the end on delete+re-add -- so
// unchecking then rechecking the same biome (a visual no-op) must NOT change
// the emitted payload order, or an unrelated save silently wipes that
// world's cached terrain.
describe('orderBiomeNames', () => {
  const catalog = [
    { id: 1, name: 'Meadow' },
    { id: 2, name: 'Desert' },
    { id: 3, name: 'Swamp' },
  ];

  it('orders selected names by catalog (id ASC) order, not Set insertion order', () => {
    const reversed = new Set(['Swamp', 'Desert', 'Meadow']);
    expect(orderBiomeNames(reversed, catalog)).toEqual(['Meadow', 'Desert', 'Swamp']);
  });

  it('uncheck-then-recheck of the same biome yields a byte-identical payload', () => {
    const before = new Set(['Meadow', 'Desert', 'Swamp']);
    const beforePayload = orderBiomeNames(before, catalog);

    // Simulate a click sequence: uncheck Meadow, then recheck it. A Set
    // moves 'Meadow' to the end of its iteration order as a result.
    const afterClicks = new Set(before);
    afterClicks.delete('Meadow');
    afterClicks.add('Meadow');
    expect([...afterClicks]).toEqual(['Desert', 'Swamp', 'Meadow']); // Set order DID shift

    const afterPayload = orderBiomeNames(afterClicks, catalog);
    expect(afterPayload).toEqual(beforePayload);
    expect(afterPayload).toEqual(['Meadow', 'Desert', 'Swamp']);
  });

  it('drops names no longer present in the catalog and accepts a plain array', () => {
    expect(orderBiomeNames(['Swamp', 'Ghost Biome', 'Meadow'], catalog)).toEqual(['Meadow', 'Swamp']);
  });

  it('handles an empty selection without crashing', () => {
    expect(orderBiomeNames(new Set(), catalog)).toEqual([]);
  });

  // The catalog is [] both while GET /api/biomes is still in flight
  // (useBiomes() defaults to `data || []` before it resolves) and if it
  // genuinely has zero rows -- there is no way to tell those apart from an
  // empty array alone. Filtering a real, non-empty selection against that
  // ambiguous [] must NOT collapse it to [] : that would emit `biomes: []`
  // for a world that still has biomes selected, trip the backend's
  // order-sensitive diff, and wipe the world's cached terrain -- the exact
  // failure this helper exists to prevent, just triggered by a load-timing
  // window instead of click order. The selection must round-trip instead.
  it('round-trips a non-empty selection when the catalog is empty or missing, instead of collapsing to []', () => {
    expect(orderBiomeNames(['Meadow', 'Desert'], [])).toEqual(['Meadow', 'Desert']);
    expect(orderBiomeNames(['Meadow'], undefined)).toEqual(['Meadow']);
    expect(orderBiomeNames(new Set(['Swamp', 'Meadow']), null)).toEqual(['Swamp', 'Meadow']);
  });
});
