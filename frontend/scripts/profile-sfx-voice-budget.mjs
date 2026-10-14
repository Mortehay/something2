#!/usr/bin/env node
// frontend/scripts/profile-sfx-voice-budget.mjs
//
// SOMET-613 (profiling pass). Checks whether a boss fight's concurrent SFX
// requests actually approach or exceed the 12-voice cap enforced by
// SfxLimiter (frontend/src/games/something2/src/js/audio/sfxLimits.js), and
// how gracefully the limiter behaves when they do (drop vs. priority
// eviction vs. unbounded growth).
//
// SfxLimiter is pure logic with no Web Audio / DOM dependency (its own
// header: "No Web Audio here"), so it runs directly under plain Node --
// no browser, no AudioEngine, no live dev stack.
//
// Run from frontend/:  node scripts/profile-sfx-voice-budget.mjs
import { SfxLimiter } from '../src/games/something2/src/js/audio/sfxLimits.js';

// A clock the limiter reads via its `now` option, advanced by the
// simulation instead of wall time, so the run is deterministic and instant.
function makeClock() {
  let t = 0;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

// One simulated boss-fight "burst": every source that could plausibly fire
// a one-shot SFX in the same ~100ms window during a real world-boss event,
// built from the actual priority tiers SfxLimiter knows about (sfxLimits.js
// SFX_PRIORITY_ORDER: nearby < nearest < boss < own):
//   - the boss's own aura pulse / DoT tick cue                  (boss, close)
//   - 2 skill telegraphs + 2 skill resolves (Meteor Slam, Nova) (boss, close)
//   - 8 minions each landing a hit or dying in the same window  (nearest, varied distance)
//   - ambient "nearby" creature/world-point loops still ticking (nearby, far)
//   - the player's own two actions (swing + a shout/emote)      (own, 0)
function bossFightBurst() {
  const events = [];
  events.push({ clipKey: 'boss_dot_tick', priority: 'boss', distance: 40 });
  events.push({ clipKey: 'skill_telegraph_slam', priority: 'boss', distance: 60 });
  events.push({ clipKey: 'skill_resolve_slam', priority: 'boss', distance: 60 });
  events.push({ clipKey: 'skill_telegraph_nova', priority: 'boss', distance: 60 });
  events.push({ clipKey: 'skill_resolve_nova', priority: 'boss', distance: 60 });
  for (let i = 0; i < 8; i++) {
    events.push({ clipKey: `minion_hit_${i % 3}`, priority: 'nearest', distance: 80 + i * 20 });
  }
  for (let i = 0; i < 4; i++) {
    events.push({ clipKey: `ambience_${i}`, priority: 'nearby', distance: 300 + i * 50 });
  }
  events.push({ clipKey: 'own_swing', priority: 'own', distance: 0 });
  events.push({ clipKey: 'own_emote', priority: 'own', distance: 0 });
  return events;
}

function runBurst(label, events, { releaseAfterMs = null } = {}) {
  const clock = makeClock();
  const limiter = new SfxLimiter({ now: clock.now });
  let admitted = 0;
  let dropped = 0;
  let evicted = 0;
  const voiceIds = [];
  for (const ev of events) {
    const { ok, evict, voiceId } = limiter.admit(ev);
    if (!ok) { dropped++; continue; }
    admitted++;
    if (evict !== undefined) evicted++;
    voiceIds.push(voiceId);
    clock.advance(1); // events in the same burst land ~1ms apart, not literally simultaneous
  }
  const peakVoices = limiter.voices.size;
  console.log(`${label}: requested=${events.length} admitted=${admitted} dropped=${dropped} evicted=${evicted} peakConcurrentVoices=${peakVoices}/${limiter.maxVoices}`);
  if (releaseAfterMs != null) {
    clock.advance(releaseAfterMs);
    for (const id of voiceIds) limiter.release(id);
  }
  return { admitted, dropped, evicted, peakVoices };
}

function run() {
  console.log('=== SOMET-613 SFX 12-voice budget under boss-fight load ===');
  console.log('');

  // --- [1] One burst: everything in bossFightBurst() landing in the same
  //     ~20ms window, nothing yet released (worst case for a single frame
  //     of a frantic multi-minion boss fight). ---
  const single = bossFightBurst();
  console.log(`Single burst composition: ${single.length} candidate SFX requests (5 boss-tier, 8 nearest-tier, 4 nearby-tier, 2 own-tier).`);
  const singleResult = runBurst('[1] Single burst, cold limiter (12-voice cap)', single);
  console.log('');

  // --- [2] Sustained fight: 20 consecutive bursts with no release between
  //     them (voices never freed -- the pathological case: do dropped
  //     requests pile up as unbounded growth, or does the cap hold?). ---
  console.log('[2] 20 consecutive bursts, voices never released (tests for unbounded growth):');
  const clock2 = makeClock();
  const limiter2 = new SfxLimiter({ now: clock2.now });
  let totalRequested = 0; let totalAdmitted = 0; let totalDropped = 0; let totalEvicted = 0;
  for (let burst = 0; burst < 20; burst++) {
    for (const ev of bossFightBurst()) {
      totalRequested++;
      const { ok, evict } = limiter2.admit(ev);
      if (!ok) totalDropped++; else { totalAdmitted++; if (evict !== undefined) totalEvicted++; }
      clock2.advance(1);
    }
    clock2.advance(150); // gap between bursts, matching roughly one DoT tick cadence
  }
  console.log(`  requested=${totalRequested} admitted=${totalAdmitted} dropped=${totalDropped} evicted=${totalEvicted} finalVoiceCount=${limiter2.voices.size}/${limiter2.maxVoices}`);
  console.log(`  -> voice count never exceeds maxVoices (${limiter2.maxVoices}) by construction (admit() enforces it before insert); growth is in dropped+evicted counts, not in held voices.`);
  console.log('');

  // --- [3] Realistic fight: bursts WITH releases in between (most voices
  //     are short one-shots that finish within ~300-600ms), to see the
  //     steady-state peak concurrency a real fight would reach. ---
  console.log('[3] 20 consecutive bursts, each voice released ~400ms after admission (realistic one-shot lifetime):');
  const clock3 = makeClock();
  const limiter3 = new SfxLimiter({ now: clock3.now });
  let peak3 = 0;
  const pending = []; // { releaseAt, id }
  for (let burst = 0; burst < 20; burst++) {
    for (const ev of bossFightBurst()) {
      // Release anything whose time has come before admitting more.
      while (pending.length && pending[0].releaseAt <= clock3.now()) {
        limiter3.release(pending.shift().id);
      }
      const { ok, voiceId } = limiter3.admit(ev);
      if (ok) pending.push({ releaseAt: clock3.now() + 400, id: voiceId });
      peak3 = Math.max(peak3, limiter3.voices.size);
      clock3.advance(1);
    }
    clock3.advance(150);
  }
  console.log(`  peakConcurrentVoices=${peak3}/${limiter3.maxVoices}`);
  console.log('');
  console.log(`Conclusion: a single boss-fight burst (${single.length} candidate one-shots across all 4 priority tiers) peaks at ${singleResult.peakVoices}/12 concurrent voices and drops ${singleResult.dropped} request(s) outright, so the cap is a live constraint in this scenario, not dead code. The limiter handles it via priority-tiered eviction (own > boss > nearest > nearby) and an explicit drop -- never unbounded growth: voices.size is checked and enforced inside admit() before every insert (sfxLimits.js:53), so held-voice count cannot exceed maxVoices regardless of request volume.`);
}

run();
