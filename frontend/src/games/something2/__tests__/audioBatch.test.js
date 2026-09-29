import { describe, it, expect } from 'vitest';
import {
  buildBatchItems, itemsFromMisses, mergeItems, batchProgress, shouldPoll,
} from '../audioBatch.js';

const subjects = [
  { kind: 'world', slots: { music: 'music', ambience: 'ambience' }, subjects: ['Vale', 'Ash'] },
  { kind: 'biome', slots: { ambience: 'ambience' }, subjects: ['Meadow'] },
];

describe('audioBatch', () => {
  it('builds kind×slot items for the ticked subjects only, deduped and ordered', () => {
    const items = buildBatchItems(new Set(['world/Vale', 'biome/Meadow', 'biome/Nope']),
      { world: new Set(['music', 'ambience']), biome: new Set(['ambience', 'music']) }, subjects);
    expect(items).toEqual([
      { subject_kind: 'biome', subject_key: 'Meadow', slot: 'ambience' },
      { subject_kind: 'world', subject_key: 'Vale', slot: 'ambience' },
      { subject_kind: 'world', subject_key: 'Vale', slot: 'music' },
    ]);
  });
  it('takes only music/ambience misses and merges without duplicates', () => {
    const m = itemsFromMisses([{ subject_kind: 'biome', subject_key: 'Meadow', slot: 'ambience' },
      { subject_kind: 'creature', subject_key: 'Slime', slot: 'hurt' }]);
    expect(m).toEqual([{ subject_kind: 'biome', subject_key: 'Meadow', slot: 'ambience' }]);
    expect(mergeItems(m, m)).toHaveLength(1);
  });
  it('reports progress and the group being drained', () => {
    const stats = { groups: { music: { queued: 0, running: 1, done: 2, failed: 0 }, ambience: { queued: 3, running: 0, done: 0, failed: 1 } }, backoff: 0 };
    const p = batchProgress({ run: { running: true }, stats });
    expect(p).toMatchObject({
      phase: 'running', done: 2, failed: 1, queued: 3, running: 1, total: 7, group: 'music',
    });
    expect(shouldPoll({ run: { running: false }, stats })).toBe(true);
    expect(shouldPoll({ run: { running: false }, stats: { groups: {}, backoff: 0 } })).toBe(false);
  });
});
