const test = require('node:test');
const assert = require('node:assert');
const {
  applyEffect, applyElementEffect, tickEffects, hasEffect, effectMagnitude,
  BURN, CHILL, SHOCK, BURN_TICK_MS,
  BURN_DURATION_MS, BURN_MAGNITUDE,
  SHOCK_MAGNITUDE, SHOCK_TICK_MS,
  applyShockInterrupt, canAct, clearInterrupt,
  SHOCK_INTERRUPT_MS, SHOCK_IMMUNITY_MS,
} = require('../src/authority/effects.js');
const { fastestCooldownMsForElement } = require('./fixtures/weapon_catalog.js');

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

// T6 gave SHOCK a periodic action (its mana drain), so it no longer belongs in
// the "purely passive" group with CHILL. CHILL alone is still read passively.
test('CHILL does not produce fired entries from tickEffects (no periodic action), but is still evicted on expiry', () => {
  const t = { effects: new Map() };
  applyEffect(t, CHILL, { durationMs: 100, magnitude: 0.5, now: 0 });
  const fired = tickEffects(t, 200, 200, {});
  assert.equal(fired.length, 0, 'CHILL has no periodic tick action');
  assert.equal(t.effects.size, 0, 'it must still be evicted once expired');
});

// An EXPIRED effect must be evicted without firing, for shock exactly as for
// burn: an entry whose expiry has passed is deleted before its interval is
// consulted, so a long dt cannot bank drain ticks for time the effect was
// already over.
test('an expired SHOCK is evicted without firing a drain tick', () => {
  const t = { effects: new Map() };
  applyEffect(t, SHOCK, { durationMs: 100, magnitude: SHOCK_MAGNITUDE, now: 0 });
  const fired = tickEffects(t, 5000, 5000, {});
  assert.equal(fired.length, 0, 'an already-expired shock must not fire drain ticks');
  assert.equal(t.effects.size, 0);
});

test('a live SHOCK fires one drain event per SHOCK_TICK_MS, at a tick-rate-independent cadence', () => {
  const t = { effects: new Map() };
  applyEffect(t, SHOCK, { durationMs: 100000, magnitude: SHOCK_MAGNITUDE, now: 0 });
  let fired = 0;
  // 4000ms of world time delivered in 50ms slices (20Hz).
  for (let ms = 50; ms <= 4000; ms += 50) fired += tickEffects(t, 50, ms, {}).length;
  assert.equal(fired, 4000 / SHOCK_TICK_MS,
    'shock drain must fire on its own fixed interval, not once per tickEffects call');
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

// --- element -> rider mapping (Task 5) --------------------------------------

function mkPlayer(id, x, y) {
  return { userId: id, x, y, width: 64, height: 64, hp: 100, maxHp: 100, effects: new Map() };
}

test('each element applies its own effect and no other', () => {
  for (const [element, key] of [['fire', BURN], ['ice', CHILL], ['lightning', SHOCK]]) {
    const t = mkPlayer('t', 0, 0);
    applyElementEffect(t, element, 0);
    assert.equal(t.effects.has(key), true, `${element} did not apply ${key}`);
    // size===1, not just has(key): asserting only presence would pass an
    // implementation that applies all four riders on every hit.
    assert.equal(t.effects.size, 1, `${element} applied more than its own effect`);
  }
});

test('arcane applies no effect at all', () => {
  const t = mkPlayer('t', 0, 0);
  applyElementEffect(t, 'arcane', 0);
  assert.equal(t.effects.size, 0, 'arcane is the pure-damage generalist and must carry no rider');
});

test('physical, null and unknown elements carry no rider', () => {
  for (const element of ['physical', null, undefined, 'plasma']) {
    const t = mkPlayer('t', 0, 0);
    assert.equal(applyElementEffect(t, element, 0), null);
    assert.equal(t.effects.size, 0, `${element} must not apply a rider`);
  }
});

test('applyElementEffect stamps duration from `now`, never from a clock read', () => {
  const t = mkPlayer('t', 0, 0);
  applyElementEffect(t, 'fire', 5000);
  assert.equal(t.effects.get(BURN).until, 5000 + BURN_DURATION_MS);
  assert.equal(t.effects.get(BURN).magnitude, BURN_MAGNITUDE);
});

// ===================================================================
// Task 7 — shock's interrupt and its non-refreshing immunity window
// ===================================================================

// Fires shock at `target` exactly as a lightning weapon hit does: through the
// one element->rider mapping, not by poking the interrupt directly. A test that
// called applyShockInterrupt itself would not notice if the storm staff's
// damage paths stopped reaching it.
const applyShock = (target, now) => applyElementEffect(target, 'lightning', now, 'attacker');

// The single-caster baseline, at the storm staff's REAL catalog rate.
//
// HONEST NOTE ON WHAT THIS TEST DOES AND DOES NOT PROVE. It is deliberately NOT
// "an interrupt was applied" — that assertion passes on the very chain-locking
// implementation this task exists to prevent. But it is also not the test that
// discriminates: SHOCK_INTERRUPT_MS (400ms) is shorter than the storm staff's
// 1100ms cooldown, so ONE caster cannot chain-lock a target even with the
// immunity window removed entirely. Verified by mutation — removing the window
// leaves this test green.
//
// It is kept as a floor (a regression that lengthened the interrupt past the
// cooldown would fail here). The two tests below are the load-bearing ones.
test('shock cannot chain-lock: the target acts for most of 10s under sustained fire at the storm staff\'s real rate', () => {
  const t = {};
  const cd = fastestCooldownMsForElement('lightning'); // 1100ms, from the catalog
  let nextShot = 0;
  let actedTicks = 0, totalTicks = 0;
  for (let ms = 0; ms < 10000; ms += 100) {
    if (ms >= nextShot) { applyShock(t, ms); nextShot = ms + cd; }
    totalTicks += 1;
    if (canAct(t, ms)) actedTicks += 1;
  }
  assert.ok(actedTicks > 50,
    `the target could act for only ${actedTicks}/${totalTicks} sampled ticks of 10s under `
    + 'sustained lightning — the immunity window is not limiting anything and shock chain-locks');
  // ...and the interrupt is not inert in the other direction either: it must
  // land SOME of the time, or "the target can always act" would pass trivially.
  assert.ok(actedTicks < totalTicks,
    'the target was never interrupted at all — the interrupt is decorative');
});

// LOAD-BEARING #1: two casters, each firing at the storm staff's real catalog
// cooldown, offset by half of it. Nothing here exceeds what the shipped catalog
// permits — this is a normal 2v1 — and the effective hit interval (550ms) is
// now SHORTER than the 400ms interrupt leaves free. Without the immunity
// window the target is interrupted ~73% of the time and the fight is over.
//
// This is the realistic scenario the window exists for, and it goes RED if the
// window is refreshed on every hit instead of running to completion.
test('shock cannot chain-lock under TWO casters firing at the storm staff\'s real rate', () => {
  const t = {};
  const cd = fastestCooldownMsForElement('lightning');
  const shots = [];
  for (let ms = 0; ms < 10000; ms += cd) { shots.push(ms); shots.push(ms + cd / 2); }
  const shotSet = new Set(shots.map((ms) => Math.round(ms / 100) * 100));

  let actedTicks = 0, totalTicks = 0;
  for (let ms = 0; ms < 10000; ms += 100) {
    if (shotSet.has(ms)) applyShock(t, ms);
    totalTicks += 1;
    if (canAct(t, ms)) actedTicks += 1;
  }
  assert.ok(actedTicks > 50,
    `under two casters at the catalog's own fire rate the target acted on only `
    + `${actedTicks}/${totalTicks} sampled ticks of 10s — the immunity window is being `
    + 'refreshed instead of running to completion, and shock chain-locks');
});

// LOAD-BEARING #2: faster than ANY weapon in the catalog can fire. The property
// must not depend on the attacker respecting a cooldown at all, because a
// multi-hit AoE, a future lightning weapon, or three casters all break that
// assumption and none of them should be able to remove a player from the game.
test('shock cannot chain-lock even when hit every 100ms, faster than any weapon can fire', () => {
  const t = {};
  let actedTicks = 0;
  for (let ms = 0; ms < 10000; ms += 100) {
    applyShock(t, ms);
    if (canAct(t, ms)) actedTicks += 1;
  }
  assert.ok(actedTicks > 50,
    `the target acted for only ${actedTicks}/100 sampled ticks — a hit rate faster than the `
    + 'weapon cooldown broke the immunity window, so two casters (or one AoE) chain-lock');
});

test('the immunity window exceeds the fastest lightning weapon cooldown', () => {
  // Reachability, not correctness. If IMMUNITY_MS <= cooldown, the exception
  // is decorative: every shot re-interrupts and the chain-lock returns.
  //
  // FASTEST_LIGHTNING_COOLDOWN_MS is DERIVED from the catalog mirror
  // (tests/fixtures/weapon_catalog.js), which is itself checked against the
  // live item_types table by authority_items_catalog.test.js. So rebalancing
  // the storm staff to fire faster than 3s fails here rather than silently
  // restoring the chain-lock.
  const FASTEST_LIGHTNING_COOLDOWN_MS = fastestCooldownMsForElement('lightning');
  assert.equal(typeof FASTEST_LIGHTNING_COOLDOWN_MS, 'number',
    'no lightning weapon found in the catalog — this invariant is guarding nothing');
  assert.ok(SHOCK_IMMUNITY_MS > FASTEST_LIGHTNING_COOLDOWN_MS,
    `immunity ${SHOCK_IMMUNITY_MS}ms must exceed the fastest lightning cooldown `
    + `${FASTEST_LIGHTNING_COOLDOWN_MS}ms, or a caster re-interrupts on every shot and the `
    + 'target never acts again');
  // The window must also leave real control time, not just clear the cooldown
  // by a hair: an immunity only marginally longer than the interrupt would pass
  // the assertion above while still feeling like a permanent stun.
  assert.ok(SHOCK_IMMUNITY_MS > SHOCK_INTERRUPT_MS * 2,
    'the immunity window must be substantially longer than the interrupt it gates');
});

test('an interrupt lands, expires on its own schedule, and does not outlive SHOCK_INTERRUPT_MS', () => {
  const t = {};
  assert.equal(canAct(t, 0), true, 'a target that was never hit must be able to act');
  assert.equal(applyShockInterrupt(t, 1000), true, 'the first interrupt must land');
  assert.equal(canAct(t, 1000), false);
  assert.equal(canAct(t, 1000 + SHOCK_INTERRUPT_MS - 1), false);
  assert.equal(canAct(t, 1000 + SHOCK_INTERRUPT_MS), true,
    'the interrupt outlived SHOCK_INTERRUPT_MS');
});

// The exception itself, asserted directly: a hit inside the window must change
// NOTHING. This is what makes the window run to completion.
test('a hit inside the immunity window neither re-interrupts nor pushes the window forward', () => {
  const t = {};
  applyShockInterrupt(t, 0);
  const immuneUntil = t._shockImmuneUntil;
  const interruptedUntil = t._interruptedUntil;

  // Hammer it throughout the window.
  for (let ms = 100; ms < SHOCK_IMMUNITY_MS; ms += 100) {
    assert.equal(applyShockInterrupt(t, ms), false, `a hit at ${ms}ms should have been absorbed`);
  }
  assert.equal(t._shockImmuneUntil, immuneUntil,
    'the immunity window was REFRESHED by later hits — it must be stamped once and run to '
    + 'completion, or (depending on which way it slips) the target is either permanently '
    + 'immune or permanently interrupted');
  assert.equal(t._interruptedUntil, interruptedUntil,
    'a later hit extended the interrupt, which is the chain-lock');
  assert.equal(canAct(t, SHOCK_INTERRUPT_MS + 1), true,
    'the target never regained control despite the window');
});

// The other half: the window must END. A window that is refreshed forever (or
// simply never expires) leaves the target permanently IMMUNE, which is inert
// rather than oppressive but is just as wrong.
test('once the immunity window lapses, the next shock interrupts again', () => {
  const t = {};
  assert.equal(applyShockInterrupt(t, 0), true);
  assert.equal(applyShockInterrupt(t, SHOCK_IMMUNITY_MS - 1), false, 'still immune');
  assert.equal(applyShockInterrupt(t, SHOCK_IMMUNITY_MS), true,
    'the immunity window never lapsed — shock became a one-time effect per target');
  assert.equal(canAct(t, SHOCK_IMMUNITY_MS), false);
});

test('every lightning damage path can interrupt, because the attempt rides the one rider mapping', () => {
  const t = {};
  assert.equal(applyElementEffect(t, 'lightning', 0, 'a'), SHOCK);
  assert.equal(canAct(t, 0), false, 'a lightning hit did not attempt an interrupt');
});

test('no other element interrupts', () => {
  for (const element of ['fire', 'ice', 'arcane', 'physical', null]) {
    const t = {};
    applyElementEffect(t, element, 0, 'a');
    assert.equal(canAct(t, 0), true, `${element} interrupted, but only lightning may`);
  }
});

test('clearInterrupt frees the target but deliberately KEEPS the immunity window', () => {
  const t = {};
  applyShockInterrupt(t, 0);
  clearInterrupt(t);
  assert.equal(canAct(t, 0), true, 'clearInterrupt did not restore control');
  assert.equal(applyShockInterrupt(t, 10), false,
    'clearing the interrupt also shed the immunity window — respawning would then be a way '
    + 'to eat a fresh interrupt immediately, i.e. a chain-lock at the spawn point');
});
