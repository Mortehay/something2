// Weapon geometry + aim helpers, shared by the attack resolver, the creature
// arc hit-test, and their tests. Pure (no DB); the catalog loader is appended
// in Task 2.

const DEFAULT_WEAPON_NAME = 'dagger';

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
  const len = Math.hypot(ax || 0, ay || 0);
  if (len > 1e-9) return { nx: ax / len, ny: ay / len };
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

function num(v) { return v == null ? null : Number(v); }

// Load the weapon catalog into a Map keyed by id. Numbers are coerced; nullable
// melee/projectile fields are kept null.
async function loadWeaponTypes(pool) {
  const r = await pool.query(
    `SELECT id, name, kind, damage, cooldown, reach, arc_width,
            range, projectile_speed, projectile_radius, pierce, mana_cost, element
     FROM weapon_types ORDER BY id ASC`,
  );
  const m = new Map();
  for (const row of r.rows) {
    m.set(row.id, {
      id: row.id,
      name: row.name,
      kind: row.kind,
      damage: Number(row.damage),
      cooldown: Number(row.cooldown),
      reach: num(row.reach),
      arc_width: num(row.arc_width),
      range: num(row.range),
      projectile_speed: num(row.projectile_speed),
      projectile_radius: num(row.projectile_radius),
      pierce: num(row.pierce),
      mana_cost: Number(row.mana_cost),
      element: row.element ?? null,
    });
  }
  return m;
}

function resolveDefaultWeaponId(mapById) {
  for (const [id, w] of mapById) if (w.name === DEFAULT_WEAPON_NAME) return id;
  const first = mapById.keys().next();
  return first.done ? null : first.value;
}

module.exports = { DEFAULT_WEAPON_NAME, normalizeAim, inArc, vectorFromFacing, loadWeaponTypes, resolveDefaultWeaponId };
