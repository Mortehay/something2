import { describe, it, expect } from 'vitest';
import { SfxLimiter } from '../sfxLimits.js';

function limiter(startMs = 0) {
  let now = startMs;
  const l = new SfxLimiter({ now: () => now });
  return { l, advance: (ms) => { now += ms; } };
}

describe('SfxLimiter', () => {
  it('admits up to 12 voices and refuses a 13th of equal priority and equal distance (a tie does not evict)', () => {
    const { l } = limiter();
    for (let i = 0; i < 12; i += 1) {
      const r = l.admit({ clipKey: `clip${i}`, priority: 'nearest', distance: 100 });
      expect(r.ok).toBe(true);
    }
    const refused = l.admit({ clipKey: 'clip12', priority: 'nearest', distance: 100 });
    expect(refused).toEqual({ ok: false });
  });

  it('an own voice at capacity evicts the farthest non-own voice unconditionally, even when it is itself farther', () => {
    const { l } = limiter();
    const ids = [];
    for (let i = 0; i < 12; i += 1) {
      const r = l.admit({ clipKey: `clip${i}`, priority: 'nearest', distance: i * 10 }); // clip11 is farthest (110)
      ids.push(r.voiceId);
    }
    // The newcomer (distance 500) is itself farther than every held voice --
    // 'own' still wins the slot: an own action is always worth hearing.
    const r = l.admit({ clipKey: 'clip12', priority: 'own', distance: 500 });
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

  // Controller ruling ("nearest win"), fix round 1 finding 3: a non-own
  // newcomer competes with the OTHER held non-own voices purely on distance.
  it('a non-own voice at capacity is refused when it is not nearer than the farthest held non-own voice', () => {
    const { l } = limiter();
    for (let i = 0; i < 12; i += 1) {
      l.admit({ clipKey: `clip${i}`, priority: 'nearest', distance: 50 }); // all at distance 50
    }
    const tooFar = l.admit({ clipKey: 'clip12', priority: 'nearest', distance: 50 }); // tied, not nearer
    expect(tooFar).toEqual({ ok: false });
    const farther = l.admit({ clipKey: 'clip13', priority: 'nearest', distance: 51 });
    expect(farther).toEqual({ ok: false });
  });

  it('a non-own voice at capacity evicts the farthest held non-own voice when it is itself nearer', () => {
    const { l } = limiter();
    const ids = [];
    for (let i = 0; i < 12; i += 1) {
      ids.push(l.admit({ clipKey: `clip${i}`, priority: 'nearest', distance: i * 10 }).voiceId); // clip11 farthest (110)
    }
    const r = l.admit({ clipKey: 'clip12', priority: 'nearest', distance: 5 }); // nearer than 110
    expect(r.ok).toBe(true);
    expect(r.evict).toBe(ids[11]);
  });

  it('a non-own voice never evicts a held own voice, however near it is', () => {
    const { l } = limiter();
    const ids = [];
    for (let i = 0; i < 11; i += 1) ids.push(l.admit({ clipKey: `own${i}`, priority: 'own', distance: 1000 }).voiceId);
    ids.push(l.admit({ clipKey: 'nearest0', priority: 'nearest', distance: 50 }).voiceId); // the only non-own voice, at 12/12
    const r = l.admit({ clipKey: 'nearest1', priority: 'nearest', distance: 0 }); // nearer than the one non-own voice
    expect(r.ok).toBe(true);
    expect(r.evict).toBe(ids[11]); // evicts the sole non-own voice, never one of the 11 own voices
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

  // Task 7 (SOMET-592): the 'nearby' tier (creature/world-point ambience) is
  // strictly below both other tiers.
  describe("the 'nearby' tier", () => {
    it("an 'own' newcomer bumps the farthest 'nearby' voice, not a nearer 'nearest' one", () => {
      const { l } = limiter();
      const ids = [];
      for (let i = 0; i < 6; i += 1) ids.push(l.admit({ clipKey: `nearest${i}`, priority: 'nearest', distance: 5 }).voiceId); // all far nearer than the nearby voices below
      for (let i = 0; i < 6; i += 1) ids.push(l.admit({ clipKey: `nearby${i}`, priority: 'nearby', distance: 200 + i * 10 }).voiceId); // farthest nearby: distance 250, ids[11]
      const r = l.admit({ clipKey: 'own0', priority: 'own', distance: 9999 }); // farther than everything, still wins
      expect(r.ok).toBe(true);
      expect(r.evict).toBe(ids[11]); // farthest 'nearby', never a 'nearest' voice
    });

    it("an 'own' newcomer falls back to bumping 'nearest' only when no 'nearby' voice is held", () => {
      const { l } = limiter();
      const ids = [];
      for (let i = 0; i < 12; i += 1) ids.push(l.admit({ clipKey: `nearest${i}`, priority: 'nearest', distance: i * 10 }).voiceId); // farthest: ids[11] at 110
      const r = l.admit({ clipKey: 'own0', priority: 'own', distance: 0 });
      expect(r.ok).toBe(true);
      expect(r.evict).toBe(ids[11]);
    });

    it("a 'nearest' newcomer bumps a held 'nearby' voice unconditionally, even when farther than every held 'nearest' voice", () => {
      const { l } = limiter();
      const ids = [];
      for (let i = 0; i < 11; i += 1) ids.push(l.admit({ clipKey: `nearest${i}`, priority: 'nearest', distance: 5 }).voiceId); // all very near
      ids.push(l.admit({ clipKey: 'nearby0', priority: 'nearby', distance: 100 }).voiceId); // the sole 'nearby' voice, at 12/12
      const r = l.admit({ clipKey: 'nearest11', priority: 'nearest', distance: 9999 }); // far farther than every held 'nearest'
      expect(r.ok).toBe(true);
      expect(r.evict).toBe(ids[11]); // the 'nearby' voice, not a nearer-competition refusal against 'nearest'
    });

    it("a 'nearest' newcomer competes with other 'nearest' voices purely on distance once no 'nearby' voice is held", () => {
      const { l } = limiter();
      const ids = [];
      for (let i = 0; i < 12; i += 1) ids.push(l.admit({ clipKey: `nearest${i}`, priority: 'nearest', distance: i * 10 }).voiceId); // farthest: ids[11] at 110
      const tooFar = l.admit({ clipKey: 'nearest12', priority: 'nearest', distance: 110 }); // tied, not nearer
      expect(tooFar).toEqual({ ok: false });
      const r = l.admit({ clipKey: 'nearest13', priority: 'nearest', distance: 5 });
      expect(r.ok).toBe(true);
      expect(r.evict).toBe(ids[11]);
    });

    it("a 'nearby' newcomer may only bump a farther held 'nearby' voice", () => {
      const { l } = limiter();
      const ids = [];
      for (let i = 0; i < 11; i += 1) ids.push(l.admit({ clipKey: `own${i}`, priority: 'own', distance: 0 }).voiceId);
      ids.push(l.admit({ clipKey: 'nearby0', priority: 'nearby', distance: 300 }).voiceId); // the sole 'nearby' voice, 12/12
      const refused = l.admit({ clipKey: 'nearby1', priority: 'nearby', distance: 0 }); // nearer than everything, but 'own' is untouchable
      // still refused if it were compared against 'own' -- but the only
      // evictable tier for 'nearby' is 'nearby' itself, and this newcomer IS
      // nearer than the held nearby voice, so it succeeds by bumping THAT one.
      expect(refused.ok).toBe(true);
      expect(refused.evict).toBe(ids[11]);
    });

    it("a 'nearby' newcomer is refused outright when no 'nearby' voice is held, however near it is", () => {
      const { l } = limiter();
      for (let i = 0; i < 11; i += 1) l.admit({ clipKey: `own${i}`, priority: 'own', distance: 1000 });
      l.admit({ clipKey: 'nearest0', priority: 'nearest', distance: 1000 }); // 12/12, no 'nearby' voice anywhere
      const r = l.admit({ clipKey: 'nearby0', priority: 'nearby', distance: 0 }); // nearer than everything
      expect(r).toEqual({ ok: false }); // may never touch 'nearest' or 'own'
    });

    it("a 'nearby' newcomer is refused against a farther-or-equal held 'nearby' voice (no ties)", () => {
      const { l } = limiter();
      for (let i = 0; i < 11; i += 1) l.admit({ clipKey: `nearest${i}`, priority: 'nearest', distance: 0 });
      l.admit({ clipKey: 'nearby0', priority: 'nearby', distance: 50 });
      const tied = l.admit({ clipKey: 'nearby1', priority: 'nearby', distance: 50 });
      expect(tied).toEqual({ ok: false });
      const farther = l.admit({ clipKey: 'nearby2', priority: 'nearby', distance: 51 });
      expect(farther).toEqual({ ok: false });
    });
  });
});
