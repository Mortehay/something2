import { describe, it, expect } from 'vitest';
import { slotRows } from '../useAudioAdmin.js';

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
