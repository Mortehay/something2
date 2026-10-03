import {
  describe, it, expect, vi, beforeEach,
} from 'vitest';
import { apiFetch } from '../src/js/net/auth.js';
import { putPrompt } from '../useAudioAdmin.js';
import { historyRows, restoreVars } from '../audioPromptDraft.js';

// Plan 2026-10-03 Task 4: the slot card's "Prompt history (N)" + Restore.
vi.mock('../src/js/net/auth.js', () => ({
  apiFetch: vi.fn(),
  authHeaders: () => ({ 'Content-Type': 'application/json' }),
}));
vi.mock('react-hot-toast', () => ({ default: { error: vi.fn(), success: vi.fn(), loading: vi.fn() } }));

const reply = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json });

// A GET /admin/prompts/:kind/:key slot entry, history deliberately out of order.
const prompt = {
  active: {
    id: '41', style: 'village', text: 'a lute by the fire', model: null, via: null, created_at: '2026-10-03T10:00:00.000Z',
  },
  history: [
    {
      id: '12', style: 'dungeon', text: 'low drums', model: null, via: null, created_at: '2026-10-01T08:00:00.000Z',
    },
    {
      id: '30', style: 'village', text: 'soft flute', model: 'qwen3.6-35b-a3b', via: 'box', created_at: '2026-10-02T08:00:00.000Z',
    },
  ],
};

describe('historyRows', () => {
  it('lists the inactive versions newest first, author = model or "hand"', () => {
    expect(historyRows(prompt)).toEqual([
      {
        id: '30', createdAt: '2026-10-02T08:00:00.000Z', author: 'qwen3.6-35b-a3b', style: 'village', text: 'soft flute',
      },
      {
        id: '12', createdAt: '2026-10-01T08:00:00.000Z', author: 'hand', style: 'dungeon', text: 'low drums',
      },
    ]);
  });

  it('is empty while the prompts are loading or the slot has no history', () => {
    expect(historyRows(undefined)).toEqual([]);
    expect(historyRows({ active: null, history: [] })).toEqual([]);
  });
});

describe('Restore', () => {
  beforeEach(() => apiFetch.mockReset());

  it('PUTs the old text and style with the CURRENT active id', async () => {
    apiFetch.mockResolvedValue(reply(200, { id: '42', active: true }));
    const old = historyRows(prompt).find((h) => h.id === '12');
    await putPrompt('world', 'Vale', restoreVars('music', old, prompt.active));

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [url, init] = apiFetch.mock.calls[0];
    expect(url).toMatch(/\/api\/audio\/admin\/prompts\/world\/Vale\/music$/);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ style: 'dungeon', text: 'low drums', expect_active_id: '41' });
  });

  it('sends expect_active_id null when the slot has no active prompt now', async () => {
    apiFetch.mockResolvedValue(reply(200, {}));
    await putPrompt('creature', 'Slime', restoreVars('hurt', { style: '', text: 'a wet slap' }, null));
    expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toEqual({ style: null, text: 'a wet slap', expect_active_id: null });
  });

  it('a 409 rejects with the server\'s reload message', async () => {
    apiFetch.mockResolvedValue(reply(409, { error: 'this prompt was changed by someone else; reload it' }));
    await expect(putPrompt('world', 'Vale', restoreVars('music', historyRows(prompt)[0], prompt.active)))
      .rejects.toThrow('this prompt was changed by someone else; reload it');
  });
});
