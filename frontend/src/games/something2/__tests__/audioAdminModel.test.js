import { describe, it, expect } from 'vitest';
import { slotRows, generateBody, generateResultMessage } from '../useAudioAdmin.js';

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

// Review fix (SOMET-592, Task 8 fix round 1): the /admin/generate success
// toast used to always say 'Clip generated and bound', even when the
// backend's 201 carried `partial: true` (some sfx variants failed mid-store)
// -- the admin never learned a generation came back short.
describe('generateResultMessage', () => {
  it('a music/ambience success (single clip, no partial concept) keeps the plain message', () => {
    expect(generateResultMessage({ clip: { id: 'c1' }, binding: { id: 1 } }, undefined))
      .toBe('Clip generated and bound');
  });

  it('a full sfx success (every requested variant stored) keeps the plain message', () => {
    const json = { clips: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], bindings: [{}, {}, {}] };
    expect(generateResultMessage(json, 3)).toBe('Clip generated and bound');
  });

  it('a partial sfx store names how many arrived, how many were asked for, and why', () => {
    const json = {
      clips: [{ id: 'a' }], bindings: [{}], partial: true, error: 'box timeout on variant 2',
    };
    expect(generateResultMessage(json, 3)).toBe('Generated 1 of 3 variant(s) — box timeout on variant 2');
  });

  it('falls back to the stored count when the requested count is missing', () => {
    const json = {
      clips: [{ id: 'a' }, { id: 'b' }], bindings: [{}, {}], partial: true, error: 'x',
    };
    expect(generateResultMessage(json, undefined)).toBe('Generated 2 of 2 variant(s) — x');
  });

  it('treats a missing or falsy json as no message worth flagging', () => {
    expect(generateResultMessage(undefined, 3)).toBe('Clip generated and bound');
    expect(generateResultMessage(null, 3)).toBe('Clip generated and bound');
  });
});
