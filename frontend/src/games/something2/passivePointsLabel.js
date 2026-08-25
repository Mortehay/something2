// The unspent-passive-points label. Pure, and in its own module for two
// reasons: vitest runs node-env here so the component cannot be rendered in a
// test, and exporting a non-component alongside a component breaks Fast
// Refresh ("nudgeLabel export is incompatible"), which silently degrades HMR
// into full reloads -- the shortest path to debugging a stale bundle.
//
// The string is the feature. A player who never opens the help learns the
// binding from this text or not at all, so "press P" is load-bearing, not
// decoration.

export function nudgeLabel(points) {
  const n = Number(points);
  // A missing count means "no progression frame yet", which must read as
  // nothing rather than as "some" -- otherwise the nudge flashes on every join,
  // including for characters with nothing to spend.
  if (!Number.isFinite(n) || n < 1) return null;
  return `${n} passive ${n === 1 ? 'point' : 'points'} — press P`;
}
