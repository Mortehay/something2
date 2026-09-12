// Weapon geometry + aim helpers, shared by the attack resolver, the creature
// arc hit-test, and their tests. Pure (no DB); the catalog loader is in items.js.

const { MAX_SUB } = require('./subStep');

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

// True iff target center (tx,ty) is within `reach` (plus optional targetRadius)
// of origin (ox,oy) AND the angle between the (already-normalized) aim vector (nx,ny)
// and the origin→target direction is within arcWidth/2 (expanded by targetRadius angular span).
function inArc(ox, oy, nx, ny, tx, ty, reach, arcWidth, targetRadius = 0) {
  const dx = tx - ox, dy = ty - oy;
  const d2 = dx * dx + dy * dy;
  if (d2 > reach * reach) return false;
  if (d2 === 0) return true;
  const halfArc = arcWidth / 2;
  if (halfArc >= Math.PI) return true;
  const d = Math.sqrt(d2);
  const dot = (dx / d) * nx + (dy / d) * ny; // cos(angle between aim and target)
  const rad = Number(targetRadius) || 0;
  if (rad > 0 && d > 0) {
    const angularPadding = Math.min(Math.PI / 4, Math.asin(Math.min(1, rad / d)));
    if (halfArc + angularPadding >= Math.PI) return true;
    return dot >= Math.cos(halfArc + angularPadding);
  }
  return dot >= Math.cos(halfArc);
}

// True when nothing blocks the straight line between two world points.
// Walks in <=MAX_SUB px steps, the same resolution projectiles use for
// terrain, so melee and ranged obey ONE rule. The endpoints are not tested:
// an attacker standing in a doorway, or a target clipping a wall corner,
// must not be self-blocking.
function hasLineOfSight(map, x0, y0, x1, y1) {
  if (!map || typeof map.isWalkable !== 'function') return true;
  const dx = x1 - x0, dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  if (!Number.isFinite(dist) || dist <= MAX_SUB) return true; // point-blank
  const steps = Math.ceil(dist / MAX_SUB);
  const sx = dx / steps, sy = dy / steps;
  // Start at 1 and stop before `steps` so both endpoints are excluded.
  for (let i = 1; i < steps; i++) {
    if (!map.isWalkable(x0 + sx * i, y0 + sy * i)) return false;
  }
  return true;
}

// Stamina cost for using a weapon.
// Reads authored stamina_cost if present, else derives a sensible cost based on
// weapon kind, weight (two-handed), reach/range, and damage.
function weaponStaminaCost(w) {
  if (!w) return 0;
  if (w.name === 'unarmed') return 0;
  if (w.stamina_cost !== undefined && w.stamina_cost !== null) {
    return Number(w.stamina_cost);
  }
  const name = String(w.name || '').toLowerCase();
  if (name === 'dagger' || name === 'knife' || name === 'stick') return 0;
  if (w.mana_cost && w.mana_cost > 0) return 0;

  if (w.kind === 'melee') {
    if (w.two_handed) {
      // 2H melee (spear, quarterstaff, 2H sword, maul): 8 - 18 stamina
      return Math.max(8, Math.min(20, Math.round(5 + (w.damage || 7) * 0.8)));
    }
    if (w.reach && w.reach <= 65) {
      // Light daggers / knives: 2 - 4 stamina
      return Math.max(2, Math.min(5, Math.round(1 + (w.damage || 4) * 0.4)));
    }
    // 1H melee (blade, sword, axe, mace): 4 - 10 stamina
    return Math.max(4, Math.min(10, Math.round(3 + (w.damage || 6) * 0.5)));
  }

  if (w.kind === 'projectile') {
    if (w.two_handed) {
      // 2H ranged (bow, crossbow, heavy staff): 6 - 16 stamina
      return Math.max(6, Math.min(16, Math.round(4 + (w.damage || 7) * 0.6)));
    }
    // 1H ranged (wand, scepter, sling, darts): 3 - 8 stamina
    return Math.max(3, Math.min(8, Math.round(2 + (w.damage || 5) * 0.4)));
  }

  return Math.max(3, Math.min(10, Math.round((w.damage || 5) * 0.5)));
}

module.exports = { normalizeAim, inArc, vectorFromFacing, hasLineOfSight, weaponStaminaCost };
