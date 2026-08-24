import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchPassiveTree, allocatePassive, respecPassives, fetchRespecQuote, fetchStartClass,
} from './passiveTreeClient.js';
import { writeActiveCharacterId, clearActiveCharacterId } from '../../../characterSession.js';

// The FETCH layer, exercised for real against a stubbed global fetch --
// deliberately not a source grep. A grep for "/api/passive-tree" still matches
// "/api/passive-treeXX", and a grep for "method: 'POST'" still matches a file
// where only one of the two POSTs survives. Both of those were live mutants
// that a source-matching version of this file let through.
const ok = (body) => ({ ok: true, status: 200, json: async () => body });

function callOf(n = 0) {
  const [url, options] = global.fetch.mock.calls[n];
  return { url, options: options || {} };
}

beforeEach(() => {
  writeActiveCharacterId(7);
  globalThis.localStorage = {
    _m: { 'something2.activeCharacterId': '7' },
    getItem(k) { return this._m[k] ?? null; },
    setItem(k, v) { this._m[k] = String(v); },
    removeItem(k) { delete this._m[k]; },
  };
});
afterEach(() => { vi.restoreAllMocks(); clearActiveCharacterId(); });

describe('fetchPassiveTree', () => {
  it('GETs exactly /api/passive-tree and returns the graph', async () => {
    const body = { nodes: [{ id: 1 }], edges: [[1, 2]], version: '1:1' };
    global.fetch = vi.fn().mockResolvedValue(ok(body));
    expect(await fetchPassiveTree('http://api')).toEqual(body);
    // Anchored: a renamed endpoint must fail here, and a substring match would
    // not notice one.
    expect(callOf().url).toBe('http://api/api/passive-tree');
  });

  it('throws the server message rather than resolving empty', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });
    await expect(fetchPassiveTree('http://api')).rejects.toThrow('boom');
  });
});

describe('allocatePassive', () => {
  it('POSTs the node id in the PATH and the character in the BODY', async () => {
    global.fetch = vi.fn().mockResolvedValue(ok({ progression: { level: 3 } }));
    await allocatePassive(42, 'http://api');
    const { url, options } = callOf();
    expect(url).toBe('http://api/api/progression/passives/42');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ character_id: 7 });
    expect(options.headers.Authorization).toBeUndefined(); // no token stored here
    expect(options.headers['Content-Type']).toBe('application/json');
  });

  it('resolves to true and hands back NO progression to write', async () => {
    // The single-writer rule, at the seam that could break it: if this ever
    // returned the body, a caller could apply it and reintroduce the second
    // writer CharacterSheet.jsx's F1 header removed.
    global.fetch = vi.fn().mockResolvedValue(ok({ progression: { level: 9 }, stats: {} }));
    expect(await allocatePassive(1, 'http://api')).toBe(true);
  });

  it('throws the server refusal so the caller can toast it', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 400, json: async () => ({ error: 'not reachable' }),
    });
    await expect(allocatePassive(1, 'http://api')).rejects.toThrow('not reachable');
  });

  it('refuses to send anything with no character selected', async () => {
    clearActiveCharacterId();
    globalThis.localStorage._m = {};
    global.fetch = vi.fn();
    await expect(allocatePassive(1, 'http://api')).rejects.toThrow(/No character selected/);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('respecPassives', () => {
  it('POSTs the respec and returns the new gold, and only the gold', async () => {
    global.fetch = vi.fn().mockResolvedValue(ok({ progression: { level: 3 }, stats: {}, gold: 1234 }));
    expect(await respecPassives('http://api')).toEqual({ gold: 1234 });
    const { url, options } = callOf();
    expect(url).toBe('http://api/api/progression/respec');
    expect(options.method).toBe('POST');
  });

  it('throws the 402 message rather than pretending it worked', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 402, json: async () => ({ error: 'not enough gold', cost: 2000 }),
    });
    await expect(respecPassives('http://api')).rejects.toThrow('not enough gold');
  });
});

describe('fetchRespecQuote', () => {
  it("reads the server's cost, gold and verdict and never recomputes them", async () => {
    global.fetch = vi.fn().mockResolvedValue(ok({
      respecCost: 2000, gold: 5000, respecDisabled: false, progression: {},
    }));
    expect(await fetchRespecQuote('http://api')).toEqual({
      respecCost: 2000, gold: 5000, respecDisabled: false,
    });
    expect(callOf().url).toBe('http://api/api/progression?character_id=7');
  });
});

describe('fetchStartClass', () => {
  it('picks the ACTIVE character out of the list', async () => {
    global.fetch = vi.fn().mockResolvedValue(ok({
      characters: [
        { id: 3, className: 'Mage' },
        { id: 7, className: 'Warrior' },
      ],
    }));
    expect(await fetchStartClass('http://api')).toBe('Warrior');
    expect(callOf().url).toBe('http://api/api/characters');
  });

  it('returns null when the active character is not in the list', async () => {
    // Deleted from another device. Returning some other character's class here
    // would draw one class's sector as reachable for another.
    global.fetch = vi.fn().mockResolvedValue(ok({ characters: [{ id: 3, className: 'Mage' }] }));
    expect(await fetchStartClass('http://api')).toBe(null);
  });
});
