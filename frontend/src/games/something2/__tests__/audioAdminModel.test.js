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
  });

  it('returns an empty tree for an empty or missing registry', () => {
    expect(slotRows([])).toEqual([]);
    expect(slotRows(undefined)).toEqual([]);
  });
});
