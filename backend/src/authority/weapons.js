// Weapon geometry + aim helpers, shared by the attack resolver, the creature
// arc hit-test, and their tests. Pure (no DB); the catalog loader is in items.js.

// Unit vector for an 8-way facing string ('n','s','e','w' and their combos,
// e.g. 'se'). Used as the aim fallback when the client sends a zero vector.
function vectorFromFacing(facing) {
  const f = typeof facing === 'string' ? facing.toLowerCase() : '';
  let x = 0, y = 0;
  if (f.includes('n')) y -= 1;
  if (f.includes('s')) y += 1;
  if (f.includes('e')) x += 1;
  if (f.includes('w')) x -= 1;
  if (x === 0 && y === 0) return { nx: 0, ny: 1 }; // default south
  const len = Math.hypot(x, y);
  return { nx: x / len, ny: y / len };
}

// Normalize an aim vector; fall back to the facing direction if it is ~zero.
function normalizeAim(ax, ay, facing) {
  const x = Number.isFinite(ax) ? ax : 0;
  const y = Number.isFinite(ay) ? ay : 0;
  const len = Math.hypot(x, y);
  if (len > 1e-9) return { nx: x / len, ny: y / len };
  return vectorFromFacing(facing);
}

// True iff target center (tx,ty) is within `reach` of origin (ox,oy) AND the
// angle between the (already-normalized) aim vector (nx,ny) and the
// origin→target direction is <= arcWidth/2. A target at the origin is a hit.
function inArc(ox, oy, nx, ny, tx, ty, reach, arcWidth) {
  const dx = tx - ox, dy = ty - oy;
  const d2 = dx * dx + dy * dy;
  if (d2 > reach * reach) return false;
  if (d2 === 0) return true;
  const d = Math.sqrt(d2);
  const dot = (dx / d) * nx + (dy / d) * ny; // cos(angle between aim and target)
  return dot >= Math.cos(arcWidth / 2);
}

module.exports = { normalizeAim, inArc, vectorFromFacing };
