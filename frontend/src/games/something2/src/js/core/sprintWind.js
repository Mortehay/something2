// The wind behind a sprinter. Pure particle logic (no canvas, no clock of its own) so
// it can be tested; RenderSystem._drawSprintWind draws what this keeps.
//
// WHY. A sprint is a speed change of x1.5 and nothing else on screen said it was on.
// Each sprinter leaves thin speed streaks and a few dust puffs BEHIND them (opposite
// to where they are moving), which fade in a third of a second, so you can see your
// own sprint -- and other players' -- at a glance.
//
// Coordinates are WORLD pixels. A particle: { x, y, vx, vy, age, life, len, kind }.
// kind 'streak' is a short line along the motion; 'puff' is a soft dust dot at the feet.

export const WIND_LIFE_S = 0.35;
export const STREAKS_PER_S = 55;
export const PUFFS_PER_S = 14;
export const MAX_PARTICLES = 220;       // a crowded sprint cannot flood the draw pass
export const MAX_EMITTERS = 24;

// `emitters`: [{ id, x, y, dx, dy }] -- the sprinters this frame (position and the unit
// direction they are MOVING in). `carry` keeps the fractional spawn debt per emitter so
// a low frame rate does not change the density. `rng` is injectable for tests.
export function stepSprintWind(state, dt, emitters, rng = Math.random) {
  const s = state || { particles: [], carry: new Map() };
  // age and move what exists, drop the dead
  const kept = [];
  for (const p of s.particles) {
    const age = p.age + dt;
    if (age >= p.life) continue;
    kept.push({ ...p, age, x: p.x + p.vx * dt, y: p.y + p.vy * dt });
  }
  const carry = new Map();
  const list = (emitters || []).slice(0, MAX_EMITTERS);
  for (const e of list) {
    const m = Math.hypot(e.dx, e.dy);
    if (!(m > 0) || !Number.isFinite(e.x) || !Number.isFinite(e.y)) continue;
    const ux = e.dx / m, uy = e.dy / m;     // direction of motion
    const px = -uy, py = ux;                // perpendicular
    const debt = (s.carry.get(e.id) || 0) + dt * (STREAKS_PER_S + PUFFS_PER_S);
    let n = Math.floor(debt);
    carry.set(e.id, debt - n);
    while (n-- > 0 && kept.length < MAX_PARTICLES) {
      const streak = rng() < STREAKS_PER_S / (STREAKS_PER_S + PUFFS_PER_S);
      // Behind the sprinter, spread across their width and a little along their length.
      const side = (rng() - 0.5) * 34;
      const back = 6 + rng() * 18;
      const x = e.x - ux * back + px * side;
      const y = e.y - uy * back + py * side;
      if (streak) {
        const drift = 60 + rng() * 70;      // streaks keep sliding backwards
        kept.push({
          x, y, vx: -ux * drift, vy: -uy * drift, age: 0, life: WIND_LIFE_S * (0.6 + rng() * 0.4),
          len: 16 + rng() * 26, ux, uy, kind: 'streak',
        });
      } else {
        kept.push({
          x, y: y + 10, vx: -ux * 14 + px * (rng() - 0.5) * 20, vy: -uy * 14 - 8 - rng() * 10,
          age: 0, life: WIND_LIFE_S * (0.8 + rng() * 0.6), len: 3 + rng() * 4, ux, uy, kind: 'puff',
        });
      }
    }
  }
  return { particles: kept, carry };
}

// 1 at birth -> 0 at death, eased so the tail disappears smoothly.
export function windAlpha(p) {
  const t = Math.min(1, Math.max(0, p.age / p.life));
  return (1 - t) * (1 - t);
}

// The sprinters of this frame, from who is sprinting and where they moved since the
// last frame. `last` is a Map id -> {x, y} kept by the caller. A sprinter who did not
// move (or teleported far) emits nothing.
export function sprintEmitters(entries, last, maxJump = 400) {
  const out = [];
  for (const e of entries) {
    const prev = last.get(e.id);
    last.set(e.id, { x: e.x, y: e.y });
    if (!e.sprinting || !prev) continue;
    const dx = e.x - prev.x, dy = e.y - prev.y;
    const d = Math.hypot(dx, dy);
    if (!(d > 0.5) || d > maxJump) continue;
    out.push({ id: e.id, x: e.x, y: e.y, dx, dy });
  }
  return out;
}
