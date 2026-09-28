import { describe, it, expect } from 'vitest';
import { slotRows, generateBody } from '../useAudioAdmin.js';

describe('slotRows', () => {
  it('flattens the registry response into a subject tree with slot kinds', () => {
    const rows = slotRows([
      { kind: 'world', label: 'Worlds', slots: { music: 'music', ambience: 'ambience' }, subjects: ['vale'] },
      { kind: 'biome', label: 'Biomes', slots: { ambience: 'ambience' }, subjects: ['forest', 'desert'] },
    ]);
    expect(rows.map((r) => `${r.kind}/${r.key}`)).toEqual(['world/vale', 'biome/forest', 'biome/desert']);
    expect(rows[0].slots).toEqual([{ slot: 'music', clipKind: 'music' }, { slot: 'ambience', clipKind: 'ambience' }]);
    // No `filled` map at all (an older/incomplete response shape) defaults
    // every row to 0 rather than throwing.
    expect(rows.map((r) => r.filled)).toEqual([0, 0, 0]);
  });

  it('returns an empty tree for an empty or missing registry', () => {
    expect(slotRows([])).toEqual([]);
    expect(slotRows(undefined)).toEqual([]);
  });

  it('carries the server-computed filled-slot count per subject, defaulting to 0 when absent', () => {
    const rows = slotRows([
      {
        kind: 'world',
        label: 'Worlds',
        slots: { music: 'music', ambience: 'ambience' },
        subjects: ['vale', 'ashport'],
        // vale has both slots bound; ashport has none and is simply absent
        // from the map -- the shape backend/src/services/audioLibrary.js's
        // filledCounts() returns.
        filled: { vale: 2 },
      },
    ]);
    expect(rows.map((r) => [r.key, r.filled])).toEqual([['vale', 2], ['ashport', 0]]);
  });
});

// Final review F7 (SOMET-590): Suggest returns a style AND the box's slot
// values for that style. If the admin then types a different style, those
// slots belong to the old style and must not be sent with the new one.
describe('generateBody', () => {
  const subject = { kind: 'world', key: 'vale' };
  const proposal = { style: 'village', slots: { tempo: 'slow' } };

  it('sends the suggested slots with the suggested style', () => {
    expect(generateBody({ subject, slot: 'music', style: 'village', prompt: 'p', proposal })).toEqual({
      subject_kind: 'world', subject_key: 'vale', slot: 'music', style: 'village', prompt: 'p', slots: { tempo: 'slow' },
    });
  });

  it('drops the suggested slots once the style was edited by hand', () => {
    const body = generateBody({ subject, slot: 'music', style: 'dungeon', prompt: '', proposal });
    expect(body.style).toBe('dungeon');
    expect(body.slots).toBeUndefined();
    expect(body.prompt).toBeUndefined();
  });

  it('sends no slots without a suggestion', () => {
    expect(generateBody({ subject, slot: 'music', style: '', prompt: '', proposal: null }).slots).toBeUndefined();
  });
});
