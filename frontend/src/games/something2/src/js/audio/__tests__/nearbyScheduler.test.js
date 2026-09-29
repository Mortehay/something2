import { describe, it, expect } from 'vitest';
import { NearbyScheduler } from '../nearbyScheduler.js';

function scheduler(opts = {}) {
  let now = 0;
  let seq = [];
  const rand = () => (seq.length ? seq.shift() : 0);
  const s = new NearbyScheduler({ now: () => now, rand, ...opts });
  return { s, advance: (ms) => { now += ms; }, setNow: (v) => { now = v; }, setRand: (values) => { seq = [...values]; } };
}

const listener = { x: 0, y: 0 };

describe('NearbyScheduler', () => {
  it('never returns an emitter outside the radius', () => {
    const { s } = scheduler({ radiusPx: 800, rand: () => 0 });
    const due = s.tick([{ id: 'a', key: 'k', x: 900, y: 0 }], listener);
    expect(due).toEqual([]);
  });

  it('at most maxVoices are due at once, nearest first', () => {
    const { s } = scheduler({ radiusPx: 1000, maxVoices: 4, rand: () => 0 });
    const emitters = [
      { id: 'far1', key: 'k', x: 500, y: 0 },
      { id: 'near1', key: 'k', x: 10, y: 0 },
      { id: 'mid1', key: 'k', x: 200, y: 0 },
      { id: 'near2', key: 'k', x: 20, y: 0 },
      { id: 'mid2', key: 'k', x: 300, y: 0 },
    ];
    // rand() === 0 -> every emitter's seeded next-time is exactly `now`, so
    // all five are due on the very first tick.
    const due = s.tick(emitters, listener);
    expect(due).toHaveLength(4);
    expect(due.map((d) => d.id)).toEqual(['near1', 'near2', 'mid1', 'mid2']); // far1 loses
    expect(due.every((d, i) => i === 0 || d.distance >= due[i - 1].distance)).toBe(true);
  });

  it('a per-emitter cadence lands within [minGap, maxGap] using the injected rand', () => {
    const { s, advance, setRand } = scheduler({ radiusPx: 1000, maxVoices: 4, minGapMs: 4000, maxGapMs: 10000 });
    // First sighting seeds next-time = now + rand()*maxGap (rand=0 -> due
    // immediately); admission then resets it to
    // now + minGap + rand()*(maxGap-minGap) (rand=0.5 -> 4000 + 3000 = 7000).
    setRand([0, 0.5]);
    const first = s.tick([{ id: 'e', key: 'k', x: 0, y: 0 }], listener);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ id: 'e', key: 'k', distance: 0 });

    advance(6999);
    expect(s.tick([{ id: 'e', key: 'k', x: 0, y: 0 }], listener)).toEqual([]); // still sounding, and not due either way
    s.ended('e'); // free the slot -- cadence alone must still gate it
    expect(s.tick([{ id: 'e', key: 'k', x: 0, y: 0 }], listener)).toEqual([]); // not due yet even with the slot free

    advance(1); // now = 7000, exactly the scheduled next-time
    expect(s.tick([{ id: 'e', key: 'k', x: 0, y: 0 }], listener)).toHaveLength(1);
  });

  it('an emitter that is due but loses the slot contest keeps trying and is not pushed further out', () => {
    const { s, advance } = scheduler({ radiusPx: 1000, maxVoices: 1, rand: () => 0 });
    const near = { id: 'near', key: 'k', x: 10, y: 0 };
    const far = { id: 'far', key: 'k', x: 500, y: 0 };
    const first = s.tick([near, far], listener);
    expect(first.map((d) => d.id)).toEqual(['near']); // only one slot; nearest wins

    // 'far' was due but not admitted -- its next-time was left untouched
    // (losing does not push it further out), so once 'near' frees the slot
    // it is immediately due again and wins it, with no extra wait.
    advance(1);
    s.ended('near');
    const second = s.tick([near, far], listener);
    expect(second.map((d) => d.id)).toEqual(['far']);
  });

  it('ended() frees a slot for a later tick', () => {
    const { s } = scheduler({ radiusPx: 1000, maxVoices: 1, rand: () => 0 });
    const a = { id: 'a', key: 'k', x: 10, y: 0 };
    const b = { id: 'b', key: 'k', x: 20, y: 0 };
    expect(s.tick([a, b], listener).map((d) => d.id)).toEqual(['a']);
    expect(s.tick([a, b], listener)).toEqual([]); // slot still held by 'a'
    s.ended('a');
    expect(s.tick([a, b], listener).map((d) => d.id)).toEqual(['b']); // 'a' is sounding again per its cadence, not due
  });

  it('clear() drops all scheduling state', () => {
    const { s } = scheduler({ radiusPx: 1000, maxVoices: 1, rand: () => 0 });
    const a = { id: 'a', key: 'k', x: 10, y: 0 };
    expect(s.tick([a], listener)).toHaveLength(1);
    s.clear();
    // Without ended(), 'a' would still read as sounding; clear() must have
    // dropped that plus its next-time so it can be re-admitted immediately.
    expect(s.tick([a], listener)).toHaveLength(1);
  });
});
