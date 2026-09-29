import { describe, it, expect } from 'vitest';
import { SfxLimiter } from '../sfxLimits.js';

function limiter(startMs = 0) {
  let now = startMs;
  const l = new SfxLimiter({ now: () => now });
  return { l, advance: (ms) => { now += ms; } };
}

describe('SfxLimiter', () => {
  it('admits up to 12 voices and refuses a 13th when all are equal priority', () => {
    const { l } = limiter();
    for (let i = 0; i < 12; i += 1) {
      const r = l.admit({ clipKey: `clip${i}`, priority: 'nearest', distance: 100 });
      expect(r.ok).toBe(true);
    }
    const refused = l.admit({ clipKey: 'clip12', priority: 'nearest', distance: 100 });
    expect(refused).toEqual({ ok: false });
  });

  it('a 13th voice evicts the farthest lower-priority voice when priority allows it', () => {
    const { l } = limiter();
    const ids = [];
    for (let i = 0; i < 12; i += 1) {
      const r = l.admit({ clipKey: `clip${i}`, priority: 'nearest', distance: i * 10 }); // clip11 is farthest (110)
      ids.push(r.voiceId);
    }
    const r = l.admit({ clipKey: 'clip12', priority: 'own', distance: 5 });
    expect(r.ok).toBe(true);
    expect(r.evict).toBe(ids[11]); // farthest 'nearest' voice, not merely the newest
  });

  it('an own action at capacity is refused when nothing lower-priority exists to bump', () => {
    const { l } = limiter();
    for (let i = 0; i < 12; i += 1) {
      l.admit({ clipKey: `clip${i}`, priority: 'own', distance: i });
    }
    const r = l.admit({ clipKey: 'clip12', priority: 'own', distance: 0 });
    expect(r).toEqual({ ok: false });
  });

  it('a non-own voice at capacity is refused outright, never evicting another non-own voice', () => {
    const { l } = limiter();
    for (let i = 0; i < 12; i += 1) {
      l.admit({ clipKey: `clip${i}`, priority: 'nearest', distance: 100 }); // all farther than the newcomer
    }
    const r = l.admit({ clipKey: 'clip12', priority: 'nearest', distance: 1 });
    expect(r).toEqual({ ok: false });
  });

  it('refuses the 4th play of the same clip within the 100ms window', () => {
    const { l, advance } = limiter();
    expect(l.admit({ clipKey: 'hit.ogg', priority: 'nearest', distance: 0 }).ok).toBe(true);
    advance(30);
    expect(l.admit({ clipKey: 'hit.ogg', priority: 'nearest', distance: 0 }).ok).toBe(true);
    advance(30);
    expect(l.admit({ clipKey: 'hit.ogg', priority: 'nearest', distance: 0 }).ok).toBe(true);
    advance(30);
    const fourth = l.admit({ clipKey: 'hit.ogg', priority: 'own', distance: 0 }); // even 'own' priority does not bypass the clip throttle
    expect(fourth).toEqual({ ok: false });
  });

  it('the same-clip window expires, allowing a play once 100ms have fully elapsed', () => {
    const { l, advance } = limiter();
    l.admit({ clipKey: 'hit.ogg', priority: 'nearest', distance: 0 });
    l.admit({ clipKey: 'hit.ogg', priority: 'nearest', distance: 0 });
    l.admit({ clipKey: 'hit.ogg', priority: 'nearest', distance: 0 });
    advance(101);
    expect(l.admit({ clipKey: 'hit.ogg', priority: 'nearest', distance: 0 }).ok).toBe(true);
  });

  it('release() frees a voice slot for a later admit', () => {
    const { l } = limiter();
    const ids = [];
    for (let i = 0; i < 12; i += 1) ids.push(l.admit({ clipKey: `clip${i}`, priority: 'nearest', distance: i }).voiceId);
    l.release(ids[0]);
    const r = l.admit({ clipKey: 'clip12', priority: 'nearest', distance: 0 });
    expect(r.ok).toBe(true);
    expect(r.evict).toBeUndefined(); // room was freed; nothing needed evicting
  });
});
