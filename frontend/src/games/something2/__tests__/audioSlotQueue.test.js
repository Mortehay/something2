import {
  describe, it, expect, vi, beforeEach,
} from 'vitest';
import { apiFetch } from '../src/js/net/auth.js';
import {
  enqueueSlotJob, generateItem, writeItem, singleEnqueueMessage, slotJobFor, isLiveJob,
  slotJobsShouldPoll, slotEnqueueBlocked,
} from '../useAudioAdmin.js';

// Plan 2026-10-03 Task 3: the slot card's Generate and "Write with model"
// go through the queue as ONE POST /api/audio/admin/jobs item each.
vi.mock('../src/js/net/auth.js', () => ({
  apiFetch: vi.fn(),
  authHeaders: () => ({ 'Content-Type': 'application/json' }),
}));
vi.mock('react-hot-toast', () => ({ default: { error: vi.fn(), success: vi.fn(), loading: vi.fn() } }));

const reply = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json });
const sentBody = () => JSON.parse(apiFetch.mock.calls[0][1].body);
const world = { kind: 'world', key: 'Vale' };
const slime = { kind: 'creature', key: 'Slime' };

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockResolvedValue(reply(201, { queued: [{ id: '9' }], already_live: [], rejected: [] }));
});

describe('single Generate', () => {
  it('posts one music item to /admin/jobs with start:true, carrying style, prompt and the suggested slots', async () => {
    const proposal = { style: 'village', slots: { tempo: 'slow' } };
    await enqueueSlotJob(generateItem({
      subject: world, slot: 'music', style: 'village', prompt: 'a lute', proposal,
    }));
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch.mock.calls[0][0]).toMatch(/\/api\/audio\/admin\/jobs$/);
    expect(apiFetch.mock.calls[0][1].method).toBe('POST');
    expect(sentBody()).toEqual({
      items: [{
        subject_kind: 'world', subject_key: 'Vale', slot: 'music', style: 'village', prompt: 'a lute', slots: { tempo: 'slow' },
      }],
      start: true,
    });
  });

  it('carries the sfx engine, variants and an integer seed', async () => {
    await enqueueSlotJob(generateItem({
      subject: slime, slot: 'hurt', engine: 'retro', variants: 5, seed: 1234,
    }));
    expect(sentBody().items).toEqual([{
      subject_kind: 'creature', subject_key: 'Slime', slot: 'hurt', engine: 'retro', variants: 5, seed: 1234,
    }]);
  });

  it('force_prompt follows the card checkbox', async () => {
    await enqueueSlotJob(generateItem({ subject: world, slot: 'music', forcePrompt: true }));
    expect(sentBody().items[0].force_prompt).toBe(true);

    apiFetch.mockClear();
    await enqueueSlotJob(generateItem({ subject: world, slot: 'music', forcePrompt: false }));
    expect(sentBody().items[0]).not.toHaveProperty('force_prompt');
  });

  it('a non-2xx answer rejects with the server error', async () => {
    apiFetch.mockResolvedValue(reply(400, { error: 'items must be an array of 1-500 entries' }));
    await expect(enqueueSlotJob(generateItem({ subject: world, slot: 'music' })))
      .rejects.toThrow('items must be an array of 1-500 entries');
  });
});

describe('Write with model', () => {
  it('posts one prompt_only + force_prompt item with the hint, start:true', async () => {
    await enqueueSlotJob(writeItem({ subject: world, slot: 'ambience', hint: '  rain on stone  ' }));
    expect(sentBody()).toEqual({
      items: [{
        subject_kind: 'world', subject_key: 'Vale', slot: 'ambience', prompt_only: true, force_prompt: true, hint: 'rain on stone',
      }],
      start: true,
    });
  });

  it('sends no hint when the hint box is blank', async () => {
    await enqueueSlotJob(writeItem({ subject: world, slot: 'music', hint: '   ' }));
    expect(sentBody().items[0]).not.toHaveProperty('hint');
  });
});

describe('what the card says after an enqueue', () => {
  it('a rejected item is an error naming the reason', () => {
    expect(singleEnqueueMessage({
      queued: [], already_live: [], rejected: [{ item: {}, error: 'variants must be an integer 1-5' }],
    }, 'Generate')).toEqual({ ok: false, message: 'Generate not queued: variants must be an integer 1-5' });
  });

  it('an already-live slot is an error, not a silent no-op', () => {
    expect(singleEnqueueMessage({ queued: [], already_live: [{ id: '3' }], rejected: [] }, 'Write with model'))
      .toEqual({ ok: false, message: 'Write with model not queued: this slot already has a queued or running job' });
  });

  it('queued is ok, and says so when no provider will start it', () => {
    expect(singleEnqueueMessage({ queued: [{ id: '9' }], started: true }, 'Generate'))
      .toEqual({ ok: true, message: 'Generate queued' });
    expect(singleEnqueueMessage({ queued: [{ id: '9' }], started: false, reason: 'no_provider' }, 'Generate'))
      .toEqual({ ok: true, message: 'Generate queued — no audio provider, press Start once one is active' });
  });
});

describe("the slot's live job", () => {
  const rows = [
    { id: '1', subject_kind: 'world', subject_key: 'Vale', slot: 'ambience', status: 'failed', error: 'no prompt' },
    { id: '2', subject_kind: 'world', subject_key: 'Vale', slot: 'music', status: 'running', error: null },
  ];

  it('finds this slot only, and only queued/running count as live', () => {
    expect(slotJobFor(rows, 'world', 'Vale', 'music').id).toBe('2');
    expect(slotJobFor(rows, 'world', 'Ash', 'music')).toBeNull();
    expect(isLiveJob(slotJobFor(rows, 'world', 'Vale', 'music'))).toBe(true);
    expect(isLiveJob(slotJobFor(rows, 'world', 'Vale', 'ambience'))).toBe(false);
    expect(isLiveJob({ status: 'queued' })).toBe(true);
    expect(isLiveJob(null)).toBe(false);
  });
});

// Review fix: a card outside the Audio tab (SubjectSounds in Biomes, Entity
// Types, Maps) stayed on "Generating…" because /jobs/slots stopped polling
// with the batch cadence while its last fetch still showed the job running.
describe('whether a slot card polls /jobs/slots', () => {
  const running = { id: '5', status: 'running' };

  it('keeps polling while its own job is live, even after the drain ended', () => {
    // The drain's run is over (batch cadence off) but the last fetch still
    // shows this slot's job running: only another fetch can clear it.
    expect(slotJobsShouldPoll({
      batchPoll: false, job: running, awaitingAt: null, slotJobsUpdatedAt: 1000,
    })).toBe(true);
    expect(slotJobsShouldPoll({
      batchPoll: false, job: { id: '5', status: 'queued' }, awaitingAt: null, slotJobsUpdatedAt: 1000,
    })).toBe(true);
  });

  it('stops once the slot has no live job and nothing awaits a fresh fetch', () => {
    expect(slotJobsShouldPoll({
      batchPoll: false, job: null, awaitingAt: null, slotJobsUpdatedAt: 1000,
    })).toBe(false);
    expect(slotJobsShouldPoll({
      batchPoll: false, job: { id: '5', status: 'failed' }, awaitingAt: 900, slotJobsUpdatedAt: 1000,
    })).toBe(false);
  });

  it('polls while an enqueue awaits a fetch newer than its response', () => {
    expect(slotJobsShouldPoll({
      batchPoll: false, job: null, awaitingAt: 2000, slotJobsUpdatedAt: 1000,
    })).toBe(true);
  });

  it('follows the batch cadence when that is on', () => {
    expect(slotJobsShouldPoll({
      batchPoll: true, job: null, awaitingAt: null, slotJobsUpdatedAt: 1000,
    })).toBe(true);
  });
});

// Review fix: between the enqueue response (isPending false) and the next
// /jobs/slots fetch, Generate was enabled again -- a double-click window.
describe('whether Generate / Write with model is blocked', () => {
  it('is blocked while the request is in flight', () => {
    expect(slotEnqueueBlocked({
      pending: true, job: null, awaitingAt: null, slotJobsUpdatedAt: 0,
    })).toBe(true);
  });

  it('stays blocked after a queued response until a newer fetch arrives', () => {
    expect(slotEnqueueBlocked({
      pending: false, job: null, awaitingAt: 5000, slotJobsUpdatedAt: 4000,
    })).toBe(true);
    // The fresh fetch shows the job: still blocked, now because it is live.
    expect(slotEnqueueBlocked({
      pending: false, job: { id: '9', status: 'queued' }, awaitingAt: 5000, slotJobsUpdatedAt: 5200,
    })).toBe(true);
    // The fresh fetch shows no job (it already finished): unblocked.
    expect(slotEnqueueBlocked({
      pending: false, job: null, awaitingAt: 5000, slotJobsUpdatedAt: 5200,
    })).toBe(false);
  });

  it('is not blocked when nothing was queued (rejected / already live clears awaiting)', () => {
    expect(slotEnqueueBlocked({
      pending: false, job: null, awaitingAt: null, slotJobsUpdatedAt: 0,
    })).toBe(false);
    expect(slotEnqueueBlocked({
      pending: false, job: { id: '1', status: 'failed' }, awaitingAt: null, slotJobsUpdatedAt: 0,
    })).toBe(false);
  });
});
