import { describe, it, expect } from 'vitest';
import { jobsRequestBody } from '../useAudioAdmin.js';
import { queueItems, queueInChunks } from '../audioSelection.js';

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
