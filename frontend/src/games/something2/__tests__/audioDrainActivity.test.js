import { describe, it, expect } from 'vitest';
import { drainActivity, formatSpan } from '../audioBatch.js';

const now = Date.parse('2026-11-01T12:00:00Z');
const ago = (s) => new Date(now - s * 1000).toISOString();

describe('drainActivity', () => {
  it('is null while no drain runs', () => {
    expect(drainActivity({ run: { running: false } }, now)).toBeNull();
    expect(drainActivity({}, now)).toBeNull();
  });

  it('explains the prompt phase: prompts left across groups, written this run, verb and age', () => {
    const a = drainActivity({
      run: {
        running: true,
        phase: 'prompt',
        prompts_written: 40,
        started_at: ago(600),
        last_progress_at: ago(7),
        current: {
          task: 'prompt', subject_kind: 'creature', subject_key: 'Woodland Miniboss', slot: 'attack', started_at: ago(5),
        },
      },
      stats: { groups: { music: { prompts: 9 }, sfx_realistic: { prompts: 720 } } },
    }, now);
    expect(a.step).toContain('729 left, 40 written this run');
    expect(a.current).toBe('writing prompt for creature/Woodland Miniboss · attack — 5s');
    expect(a.last).toBe('last job finished 7s ago');
  });

  it('names an audio pack and says nothing finished yet when nothing has', () => {
    const a = drainActivity({
      run: {
        running: true,
        phase: 'audio',
        started_at: ago(65),
        current: {
          task: 'audio', subject_kind: 'creature', subject_key: 'Wolf', slot: 'hit', pack_size: 12, started_at: ago(65),
        },
      },
      stats: { groups: {} },
    }, now);
    expect(a.step).toBe('Step 2 of 2 — generating audio.');
    expect(a.current).toBe('generating creature/Wolf · hit (+11 more in this pack) — 1m 05s');
    expect(a.last).toBe('no job finished yet (started 1m 05s ago)');
  });

  it('formats spans', () => {
    expect(formatSpan(-5)).toBe('0s');
    expect(formatSpan(3 * 3600 * 1000 + 4 * 60 * 1000)).toBe('3h 04m');
  });
});
