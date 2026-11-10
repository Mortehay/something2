'use strict';
// Amber Stance rules: pure state on the player object (p.amber). No I/O.

let config = { maxMs: 30000, afterReadyMs: 10000, variants: [] };
let nextArrival = 1;

function setAmberConfig({ maxMs, afterReadyMs, variants }) {
  config = { maxMs, afterReadyMs, variants: Array.isArray(variants) ? variants.slice() : [] };
}

function getAmberConfig() {
  return { maxMs: config.maxMs, afterReadyMs: config.afterReadyMs, variants: config.variants.slice() };
}

function seal(p, now, rng = Math.random) {
  const { variants, maxMs } = config;
  const variant = variants.length
    ? variants[Math.min(variants.length - 1, Math.floor(rng() * variants.length))]
    : null;
  p.amber = {
    arrival: nextArrival++,
    startedAt: now,
    hardEndAt: now + maxMs,
    endAt: now + maxMs,
    readyAt: null,
    variant,
  };
}

function markReady(p, arrival, now) {
  const a = p.amber;
  if (!a || a.arrival !== arrival || a.readyAt !== null) return false;
  a.readyAt = now;
  a.endAt = Math.min(a.hardEndAt, now + config.afterReadyMs);
  return true;
}

function breakOut(p, arrival, now) {
  const a = p.amber;
  if (!a || a.arrival !== arrival || a.readyAt === null || now >= a.endAt) return false;
  p.amber = null;
  return true;
}

function isSealed(p, now) {
  return !!p.amber && now < p.amber.endAt;
}

// Harm guards (Task 3): must harm skip `p`? True only for a PLAYER (userId set;
// creatures never carry one) that is sealed. `now` is the world clock every
// harm site already threads. A caller with no finite clock -- knockback
// geometry, or a legacy applyDamage call that omits `now` -- fails CLOSED: a
// player still carrying an amber record is treated as sealed. That cannot
// over-protect for long: World.tick runs expire() on every player at the top
// of every tick, so a lingering record is at most one tick stale.
function isUntargetable(p, now) {
  if (!p || p.userId == null || !p.amber) return false;
  return Number.isFinite(now) ? now < p.amber.endAt : true;
}

function expire(p, now) {
  if (!p.amber || now < p.amber.endAt) return false;
  p.amber = null;
  return true;
}

function amberView(p, now) {
  const a = p.amber;
  if (!a) return null;
  return { a: a.arrival, ms: Math.max(0, a.endAt - now), v: a.variant };
}

module.exports = { setAmberConfig, getAmberConfig, seal, markReady, breakOut, isSealed, isUntargetable, expire, amberView };
