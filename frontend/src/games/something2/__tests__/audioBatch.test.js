import { describe, it, expect } from 'vitest';
import {
  buildBatchItems, itemsFromMisses, mergeItems, batchProgress, shouldPoll, hasBatchActivity,
  subjectSlotsFor, queuedToDiscard, runStopWarning, groupRunningText,
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
// SOMET-591 final review F4/F5/F6: the panel's Discard queued button, its
// stop-reason warning, and the per-group "running" label.
describe('batch panel predicates', () => {
  const stats = (queued, running) => ({
    groups: {
      music: {
        queued, running, done: 1, failed: 0,
      },
      ambience: {
        queued: 0, running: 0, done: 0, failed: 0,
      },
    },
    backoff: 0,
  });

  it('queuedToDiscard is the queued count, and 0 while a drain runs', () => {
    expect(queuedToDiscard({ run: { running: false }, stats: stats(3, 0) })).toBe(3);
    expect(queuedToDiscard({ run: { running: true }, stats: stats(3, 1) })).toBe(0);
    expect(queuedToDiscard({ run: null, stats: stats(0, 0) })).toBe(0);
    expect(queuedToDiscard({})).toBe(0);
  });

  it('shouldPoll stops once nothing is queued, even with interrupted running rows left over', () => {
    expect(shouldPoll({ run: { running: false }, stats: stats(0, 1) })).toBe(false);
    expect(shouldPoll({ run: { running: false }, stats: stats(2, 0) })).toBe(true);
    expect(shouldPoll({ run: { running: true }, stats: stats(0, 0) })).toBe(true);
  });

  it('runStopWarning explains every stop other than empty/stopped, with the run error', () => {
    expect(runStopWarning(null)).toBe(null);
    expect(runStopWarning({ running: false, stopped_reason: null })).toBe(null);
    expect(runStopWarning({ running: false, stopped_reason: 'empty', error: 'old retry' })).toBe(null);
    expect(runStopWarning({ running: false, stopped_reason: 'stopped', error: 'x' })).toBe(null);
    expect(runStopWarning({ running: false, stopped_reason: 'breaker', error: 'box down' }))
      .toMatch(/repeated provider failures \(box down\)/);
    expect(runStopWarning({ running: false, stopped_reason: 'error', error: 'connection terminated' }))
      .toMatch(/connection terminated/);
    expect(runStopWarning({ running: false, stopped_reason: 'no_provider', error: 'no audio provider is active' }))
      .toMatch(/no audio provider is active/);
    expect(runStopWarning({ running: false, stopped_reason: 'error' })).toMatch(/no detail/);
  });

  it('groupRunningText calls running rows "interrupted" when no drain is running', () => {
    expect(groupRunningText({ running: true }, 1)).toBe('1 running');
    expect(groupRunningText({ running: false }, 2)).toBe('2 interrupted — press Start');
    expect(groupRunningText(null, 1)).toBe('1 interrupted — press Start');
    expect(groupRunningText({ running: false }, 0)).toBe('0 running');
  });
});

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
