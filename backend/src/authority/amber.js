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

module.exports = { setAmberConfig, getAmberConfig, seal, markReady, breakOut, isSealed, expire, amberView };
