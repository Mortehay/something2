const test = require('node:test');
const assert = require('node:assert');
const {
  applyEffect, tickEffects, hasEffect, effectMagnitude,
  BURN, CHILL, SHOCK, BURN_TICK_MS,
} = require('../src/authority/effects.js');

// --- brief tests, verbatim ---

test('applying an effect twice refreshes rather than stacking', () => {
  const t = { effects: new Map() };
  applyEffect(t, BURN, { durationMs: 1000, magnitude: 3, now: 0 });
  applyEffect(t, BURN, { durationMs: 1000, magnitude: 3, now: 400 });
  assert.equal(t.effects.size, 1, 'a second application must not add an entry');
  assert.equal(t.effects.get(BURN).until, 1400, 'the later application must extend expiry');
});

test('an expired effect is removed and stops acting', () => {
  const t = { effects: new Map() };
  applyEffect(t, CHILL, { durationMs: 500, magnitude: 0.6, now: 0 });
  assert.equal(hasEffect(t, CHILL, 400), true);
  assert.equal(hasEffect(t, CHILL, 600), false);
  tickEffects(t, 100, 600, {});
  assert.equal(t.effects.size, 0, 'tick must evict expired entries, not just report them false');
});

test('effect entries are bounded by effect KIND, not by rate of application', () => {
  const t = { effects: new Map() };
  for (let i = 0; i < 500; i++) applyEffect(t, BURN, { durationMs: 100, magnitude: 1, now: i });
  assert.equal(t.effects.size, 1);
});

// --- additional tests ---

test('refreshing an effect updates magnitude and sourceId, not just expiry', () => {
  const t = { effects: new Map() };
  applyEffect(t, BURN, { durationMs: 1000, magnitude: 3, sourceId: 'p1', now: 0 });
  applyEffect(t, BURN, { durationMs: 1000, magnitude: 9, sourceId: 'p2', now: 100 });
  const e = t.effects.get(BURN);
  assert.equal(e.magnitude, 9, 'refresh must replace the old magnitude, not keep the weaker/first one');
  assert.equal(e.sourceId, 'p2');
});

test('hasEffect/effectMagnitude on a target with no effects at all do not throw', () => {
  const t = { effects: new Map() };
  assert.equal(hasEffect(t, BURN, 0), false);
  assert.equal(effectMagnitude(t, BURN, 0), 0);
});

test('effectMagnitude reads the live magnitude and 0 once past expiry, without needing a tick first', () => {
  const t = { effects: new Map() };
  applyEffect(t, CHILL, { durationMs: 200, magnitude: 0.5, now: 0 });
  assert.equal(effectMagnitude(t, CHILL, 100), 0.5);
  assert.equal(effectMagnitude(t, CHILL, 300), 0, 'expired effect must read as 0 even before tickEffects evicts it');
});

test('BURN fires on its fixed interval regardless of how large a single dt is', () => {
  const t = { effects: new Map() };
  applyEffect(t, BURN, { durationMs: 10000, magnitude: 2, sourceId: 's1', now: 0 });
  // A single huge dt spanning exactly 3 intervals must fire exactly 3 times,
  // not once (once-per-call would silently make DOT damage independent of
  // elapsed time, i.e. it would scale inversely with how coarsely tick() is
  // called).
  const fired = tickEffects(t, BURN_TICK_MS * 3, BURN_TICK_MS * 3, {});
  assert.equal(fired.length, 3, 'a dt spanning 3 intervals must fire 3 burn ticks');
  for (const f of fired) {
    assert.equal(f.magnitude, 2);
    assert.equal(f.sourceId, 's1');
    assert.equal(f.key, BURN);
  }
});

test('BURN total tick count over a fixed wall-clock duration is independent of the server tick rate', () => {
  // This is the property the module exists to guarantee: burn damage must
  // not silently scale if the world tick rate changes (e.g. 20Hz -> 30Hz).
  // Simulate both rates covering the same 2000ms of real time and assert
  // they fire the same number of times.
  const totalMs = 2000;
  const longDurationMs = totalMs + 60000; // outlives the observation window

  const at20Hz = { effects: new Map() };
  applyEffect(at20Hz, BURN, { durationMs: longDurationMs, magnitude: 2, now: 0 });
  let fired20 = 0;
  for (let now = 50; now <= totalMs; now += 50) {
    fired20 += tickEffects(at20Hz, 50, now, {}).length;
  }

  const at30Hz = { effects: new Map() };
  applyEffect(at30Hz, BURN, { durationMs: longDurationMs, magnitude: 2, now: 0 });
  let fired30 = 0;
  const dt30 = 1000 / 30;
  for (let now = dt30; now <= totalMs; now += dt30) {
    fired30 += tickEffects(at30Hz, dt30, now, {}).length;
  }

  assert.equal(fired20, fired30, '20Hz and 30Hz tick rates must produce the same number of burn ticks over equal real time');
  assert.equal(fired20, Math.floor(totalMs / BURN_TICK_MS));
});

test('CHILL and SHOCK do not produce fired entries from tickEffects (no periodic action), but are still evicted on expiry', () => {
  const t = { effects: new Map() };
  applyEffect(t, CHILL, { durationMs: 100, magnitude: 0.5, now: 0 });
  applyEffect(t, SHOCK, { durationMs: 100, magnitude: 1, now: 0 });
  const fired = tickEffects(t, 200, 200, {});
  assert.equal(fired.length, 0, 'CHILL/SHOCK have no periodic tick action');
  assert.equal(t.effects.size, 0, 'both must still be evicted once expired');
});

test('tickEffects on a target with no effects map/entries is a no-op that returns an empty array', () => {
  const t = { effects: new Map() };
  assert.deepEqual(tickEffects(t, 100, 100, {}), []);
});

test('a still-live, non-expiring effect is left in place by tickEffects', () => {
  const t = { effects: new Map() };
  applyEffect(t, CHILL, { durationMs: 1000, magnitude: 0.5, now: 0 });
  tickEffects(t, 100, 100, {});
  assert.equal(t.effects.size, 1, 'a live effect must not be evicted early');
  assert.equal(hasEffect(t, CHILL, 100), true);
});
