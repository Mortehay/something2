import { describe, it, expect } from 'vitest';
import { jobsRequestBody } from '../useAudioAdmin.js';
import { queueItems, queueInChunks } from '../audioSelection.js';
import { drainPhaseText, waitingText } from '../audioBatch.js';

// Plan 2026-10-03 Task 3: the batch "Force regenerate prompt" checkbox must
// reach the POST /api/audio/admin/jobs body, not stop at the item list.
describe('the queue request body', () => {
  const row = {
    id: 'world/Ash/music', kind: 'world', key: 'Ash', slot: 'music', clipKind: 'music', uploadOnly: false,
  };
  const rowsById = new Map([[row.id, row]]);

  it('carries force_prompt on each item when Force is ticked', async () => {
    const { items } = queueItems(new Set([row.id]), rowsById, { forcePrompt: true });
    const sent = [];
    await queueInChunks(items, async (chunk) => { sent.push(jobsRequestBody(chunk, undefined)); return {}; });
    expect(sent).toEqual([{
      items: [{ subject_kind: 'world', subject_key: 'Ash', slot: 'music', force_prompt: true }],
      start: true,
      provider_id: undefined,
    }]);
  });

  it('carries no force_prompt when Force is unticked, and passes an integer provider id', async () => {
    const { items } = queueItems(new Set([row.id]), rowsById, {});
    const body = jobsRequestBody(items, 4);
    expect(body).toEqual({
      items: [{ subject_kind: 'world', subject_key: 'Ash', slot: 'music' }], start: true, provider_id: 4,
    });
    expect(JSON.parse(JSON.stringify(body)).items[0]).not.toHaveProperty('force_prompt');
  });
});

// Plan 2026-10-03 Task 3: the batch panel's status while the drain waits on
// the box (a refused model switch pauses it; it never fails a job).
describe('the drain status text', () => {
  // Built from LOCAL fields so the expected hh:mm holds in any time zone.
  const since = new Date(2026, 9, 3, 9, 5, 30).toISOString();

  it('says which model it waits for, since when (local hh:mm), and why', () => {
    const run = {
      running: true,
      phase: 'prompt',
      waiting: { model: 'brain:qwen3.6-35b-a3b', reason: 'switch refused: 409 a job is running', since },
    };
    expect(waitingText(run)).toEqual({
      line: 'Waiting for box: brain:qwen3.6-35b-a3b (since 09:05)',
      reason: 'switch refused: 409 a job is running',
    });
  });

  it('shows nothing while not waiting, and drops an unparseable since', () => {
    expect(waitingText({ running: true, phase: 'audio', waiting: null })).toBeNull();
    expect(waitingText(null)).toBeNull();
    expect(waitingText({ waiting: { model: 'audio:ace-step', reason: 'busy', since: 'garbage' } }))
      .toEqual({ line: 'Waiting for box: audio:ace-step', reason: 'busy' });
  });

  it('names the phase the drain is in', () => {
    expect(drainPhaseText({ phase: 'prompt' })).toBe('writing prompts');
    expect(drainPhaseText({ phase: 'audio' })).toBe('generating audio');
    expect(drainPhaseText({ phase: null })).toBeNull();
    expect(drainPhaseText(null)).toBeNull();
  });
});
