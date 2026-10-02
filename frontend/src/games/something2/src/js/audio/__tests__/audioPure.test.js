import { describe, it, expect } from 'vitest';
import {
  resolveChain, pickWeighted, ambienceChain, musicChain, nearbyPointPath,
} from '../audioLookup.js';
import { BiomeTracker } from '../biomeTracker.js';
import { MissLog } from '../missLog.js';
import { loadVolumes, saveVolumes, DEFAULT_VOLUMES } from '../audioSettings.js';

describe('resolveChain', () => {
  const b = { 'world/vale/ambience': [{ key: 'w' }], 'biome/forest/ambience': [] };
  it('falls back biome -> world and reports the most specific miss when all are empty', () => {
    expect(resolveChain(b, ambienceChain('vale', 'forest'))).toEqual({ clips: [{ key: 'w' }], key: 'world/vale/ambience' });
    expect(resolveChain({}, ambienceChain('vale', 'forest'))).toEqual({ clips: [], key: null, missKey: 'biome/forest/ambience' });
    expect(ambienceChain('vale', null)).toEqual(['world/vale/ambience']);
    expect(musicChain('vale')).toEqual(['world/vale/music']);
  });
});

describe('pickWeighted', () => {
  it('respects weights and handles empty lists', () => {
    const clips = [{ key: 'a', weight: 1 }, { key: 'b', weight: 3 }];
    expect(pickWeighted(clips, () => 0.1).key).toBe('a');
    expect(pickWeighted(clips, () => 0.5).key).toBe('b');
    expect(pickWeighted([], () => 0.5)).toBe(null);
  });
});

describe('BiomeTracker', () => {
  it('commits a new biome only after it holds for holdMs; border flicker never switches', () => {
    const t = new BiomeTracker({ holdMs: 1500 });
    expect(t.sample('forest', 0)).toBe('forest');           // first known biome commits at once
    for (let ms = 100; ms < 2900; ms += 200) {                // flicker every 200 ms
      expect(t.sample(ms % 400 === 100 ? 'desert' : 'forest', ms)).toBeUndefined();
    }
    expect(t.sample('desert', 3000)).toBeUndefined();
    expect(t.sample('desert', 4499)).toBeUndefined();
    expect(t.sample('desert', 4500)).toBe('desert');
    expect(t.sample(null, 5000)).toBeUndefined();            // unknown keeps current
  });
});

describe('MissLog', () => {
  it('records each key once and drains in the server shape', () => {
    const m = new MissLog();
    expect(m.record('biome/forest/ambience', 'vale')).toBe(true);
    expect(m.record('biome/forest/ambience', 'vale')).toBe(false);
    expect(m.drain()).toEqual([{ subject_kind: 'biome', subject_key: 'forest', slot: 'ambience', world: 'vale' }]);
    expect(m.drain()).toEqual([]);
    expect(m.record('biome/forest/ambience', 'vale')).toBe(false); // still once per session
  });
  it('keeps subject keys that contain slashes intact', () => {
    const m = new MissLog();
    m.record('world/Vale/North/music', 'x');
    expect(m.drain()[0]).toMatchObject({ subject_kind: 'world', subject_key: 'Vale/North', slot: 'music' });
  });
});

describe('audioSettings', () => {
  it('returns defaults when storage throws, and round-trips when it works', () => {
    const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
    expect(loadVolumes(throwing)).toEqual(DEFAULT_VOLUMES);
    expect(() => saveVolumes({ ...DEFAULT_VOLUMES, music: 0.1 }, throwing)).not.toThrow();
    const mem = new Map();
    const store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
    saveVolumes({ ...DEFAULT_VOLUMES, music: 0.1 }, store);
    expect(loadVolumes(store).music).toBe(0.1);
    store.setItem('something2.audio.volumes', '{"music": 7, "master": "loud"}');
    expect(loadVolumes(store)).toEqual(DEFAULT_VOLUMES);     // out-of-range and wrong types fall back
  });
});

// SOMET-592 (M7): the loop-vs-cadence choice is the slot's, not one pick's.
describe('nearbyPointPath', () => {
  const plain = { key: 'a.ogg', weight: 5, loopable: false };
  const loop = { key: 'b.ogg', weight: 1, loopable: true };
  it('loops when any bound clip is loopable, and only loopable clips are loop candidates', () => {
    expect(nearbyPointPath([plain, loop])).toEqual({ loop: true, clips: [loop] });
    expect(nearbyPointPath([loop, plain])).toEqual({ loop: true, clips: [loop] });
  });
  it('takes the cadence path, with every clip, when none is loopable', () => {
    expect(nearbyPointPath([plain])).toEqual({ loop: false, clips: [plain] });
    expect(nearbyPointPath([])).toEqual({ loop: false, clips: [] });
    expect(nearbyPointPath(undefined)).toEqual({ loop: false, clips: [] });
  });
});
