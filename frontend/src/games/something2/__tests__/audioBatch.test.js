import { describe, it, expect } from 'vitest';
import {
  buildBatchItems, itemsFromMisses, mergeItems, batchProgress, shouldPoll, hasBatchActivity,
  subjectSlotsFor,
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

  // Review finding: a backend restart leaves `run` as the dispatcher's
  // zeroed default (running:false, done:0, failed:0, started_at:null) even
  // though the done/failed ROWS survive in audio_jobs -- stats still counts
  // them. Reading only `run.done`/`run.failed`/`run.started_at` reported
  // 'idle' here and hid the panel (Retry/Clear/failure list) behind a done
  // batch nobody could see.
  it('is not idle when only stats (not run) carries done/failed rows, e.g. after a backend restart', () => {
    const zeroedRun = {
      running: false, started_at: null, finished_at: null, done: 0, failed: 0, stopped_reason: null,
    };
    const stats = {
      groups: {
        music: {
          queued: 0, running: 0, done: 3, failed: 0,
        },
        ambience: {
          queued: 0, running: 0, done: 0, failed: 1,
        },
      },
      backoff: 0,
    };
    const p = batchProgress({ run: zeroedRun, stats });
    expect(p.total).toBe(4);
    expect(p.phase).not.toBe('idle');
    expect(p.phase).toBe('finished');
    expect(hasBatchActivity({ run: zeroedRun, stats })).toBe(true);
  });

  it('hasBatchActivity is false with no run and no stats at all', () => {
    expect(hasBatchActivity({})).toBe(false);
    expect(hasBatchActivity()).toBe(false);
  });
});

// Task 7 (SOMET-591 slice 2, Sounds sections in the world/biome editors):
// SubjectSounds is a thin render over this -- it looks up ONE kind's slot
// list out of the same registry response slotRows() flattens, without
// needing the full subject-tree fan-out slotRows does.
describe('subjectSlotsFor', () => {
  it("returns the matching group's slot list as {slot, clipKind} pairs", () => {
    expect(subjectSlotsFor(subjects, 'world')).toEqual([
      { slot: 'music', clipKind: 'music' },
      { slot: 'ambience', clipKind: 'ambience' },
    ]);
    expect(subjectSlotsFor(subjects, 'biome')).toEqual([{ slot: 'ambience', clipKind: 'ambience' }]);
  });

  it('returns [] for a kind not present in the registry', () => {
    expect(subjectSlotsFor(subjects, 'creature')).toEqual([]);
  });

  it('returns [] for a missing or empty registry response', () => {
    expect(subjectSlotsFor(undefined, 'world')).toEqual([]);
    expect(subjectSlotsFor([], 'world')).toEqual([]);
  });
});
