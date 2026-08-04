// Deliberate frontend reimplementation of three backend formulas: xpFloor,
// xpToNext (backend/src/services/playerStats.js) and the respec cost
// (progressionConstants.RESPEC_BASE * level). Frontend is ESM, backend is
// CommonJS -- backend modules cannot be imported here -- and GET
// /api/progression already ships xpFloor/xpToNext/respecCost, but that
// snapshot goes stale the instant a websocket 'progression' push lands with a
// new level (kill XP, death). Refetching on every push is explicitly the
// wrong tradeoff (SOMET-242 task 10 brief: "handles a stream of no-op
// updates without flickering or refetching"), and these three formulas are
// simple, stable one-liners, so duplicating them locally is safer than an
// HTTP round trip per XP tick. If the backend curve ever changes, this file
// must change with it -- nothing enforces that automatically beyond both
// sides being this short.
const XP_BASE = 100;       // playerStats.js / progressionConstants.js XP_BASE
const MAX_LEVEL = 50;      // progressionConstants.js MAX_LEVEL
const RESPEC_BASE = 50;    // progressionConstants.js RESPEC_BASE

function clampLevel(level) {
  const l = Math.floor(Number(level) || 1);
  return Math.min(Math.max(l, 1), MAX_LEVEL);
}

// Cumulative XP at which `level` begins (triangular sum, same derivation as
// the backend's xpFloor).
export function xpFloor(level) {
  const l = clampLevel(level);
  return (XP_BASE * (l - 1) * l) / 2;
}

// XP needed to go from `level` to `level + 1`. Infinity at MAX_LEVEL, exactly
// like the backend -- callers must not divide by this without checking.
export function xpToNext(level) {
  const l = clampLevel(level);
  return l >= MAX_LEVEL ? Infinity : XP_BASE * l;
}

export function respecCost(level) {
  return RESPEC_BASE * clampLevel(level);
}
