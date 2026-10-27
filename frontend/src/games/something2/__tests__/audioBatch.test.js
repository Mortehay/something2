import { describe, it, expect } from 'vitest';
import {
  batchProgress, shouldPoll, hasBatchActivity,
  subjectSlotsFor, queuedToDiscard, runStopWarning, groupRunningText, uploadOnlySlotIds, doneRose,
} from '../audioBatch.js';

const subjects = [
  { kind: 'world', slots: { music: 'music', ambience: 'ambience' }, subjects: ['Vale', 'Ash'] },
  { kind: 'biome', slots: { ambience: 'ambience' }, subjects: ['Meadow'] },
];

// A creature kind carrying sfx slots, two of which (nearby/attack) have no
// cue on the box today (spec §4) -- exercises the upload-only skip path.
const subjectsWithSfx = [
  ...subjects,
  {
    kind: 'creature',
    slots: { nearby: 'sfx', attack: 'sfx', hurt: 'sfx', death: 'sfx' },
    subjects: ['Slime'],
    cues: { Slime: { nearby: null, attack: null, hurt: 'hit', death: 'death' } },
  },
];

describe('audioBatch', () => {
  it('uploadOnlySlotIds collects every null-cue (kind, key, slot) and ignores kinds with no cues', () => {
    const ids = uploadOnlySlotIds(subjectsWithSfx);
    expect(ids.has('creature/Slime/nearby')).toBe(true);
    expect(ids.has('creature/Slime/attack')).toBe(true);
    expect(ids.has('creature/Slime/hurt')).toBe(false);
    expect(ids.has('creature/Slime/death')).toBe(false);
    expect(uploadOnlySlotIds(subjects).size).toBe(0);
    expect(uploadOnlySlotIds(undefined).size).toBe(0);
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
// list out of the registry response, without
// needing the slot table's full kind×subject×slot fan-out.
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

describe('doneRose', () => {
  const stats = (music, sfx) => ({
    groups: {
      music: { queued: 0, running: 0, done: music, failed: 0 },
      sfx_realistic: { queued: 0, running: 0, done: sfx, failed: 1 },
    },
    backoff: 0,
  });
  it('is true when the done total across groups rose between polls', () => {
    expect(doneRose(stats(1, 2), stats(1, 3))).toBe(true);
    expect(doneRose(stats(1, 2), stats(2, 2))).toBe(true);
  });
  it('is false when it stayed the same, fell (Clear finished), or there is no previous poll', () => {
    expect(doneRose(stats(1, 2), stats(1, 2))).toBe(false);
    expect(doneRose(stats(4, 2), stats(0, 0))).toBe(false);
    expect(doneRose(undefined, stats(1, 2))).toBe(false);
    expect(doneRose(stats(1, 2), undefined)).toBe(false);
  });

  it('SOMET-605: with a key, a creature with subjectSlots gets only its own slots', () => {
    const reg = [{
      kind: 'creature', slots: { hurt: 'sfx', presence: 'sfx' }, subjects: ['Ignis', 'Slime'],
      subjectSlots: { Ignis: ['hurt', 'presence'], Slime: ['hurt'] },
    }];
    expect(subjectSlotsFor(reg, 'creature', 'Slime')).toEqual([{ slot: 'hurt', clipKind: 'sfx' }]);
    expect(subjectSlotsFor(reg, 'creature', 'Ignis').map((s) => s.slot)).toEqual(['hurt', 'presence']);
    expect(subjectSlotsFor(subjects, 'world', 'Vale')).toEqual([
      { slot: 'music', clipKind: 'music' }, { slot: 'ambience', clipKind: 'ambience' },
    ]);
  });
});
