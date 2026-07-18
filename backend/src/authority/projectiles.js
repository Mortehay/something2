// Server-simulated projectiles (arrows, magic bolts, …). Transient in-memory
// only — never persisted, no randomness. Collides with terrain, creatures, and
// players (never the owner). Ranged and magic share this one path; they differ
// only by weapon data.

const { applyDamage, NO_MITIGATION } = require('./damage');

function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }

class ProjectileSim {
  constructor() {
    this.projectiles = [];
    this._id = 0;
  }

  spawn({ ownerId, x, y, nx, ny, weapon }) {
    const id = String(++this._id);
    this.projectiles.push({
      id,
      ownerId,
      x, y,
      vx: nx * weapon.projectile_speed,
      vy: ny * weapon.projectile_speed,
      remaining: weapon.range,
      damage: weapon.damage,
      radius: weapon.projectile_radius,
      pierceLeft: weapon.pierce,
      element: weapon.element ?? null,
      hitIds: new Set(), // 'c:<id>' / 'p:<id>' already hit by this projectile
    });
    return id;
  }

  // Advance every projectile one tick; resolve terrain, creature, and player
  // collisions. Returns the creature ids killed this step (for the caller to
  // DELETE).
  //
  // Movement is SUB-STEPPED in <=MAX_SUB px increments so a fast projectile
  // cannot tunnel through a target within a single tick: a bow (900 px/s) moves
  // ~45 px per 20 Hz tick, larger than a creature's ~32 px capture radius, so a
  // single end-of-tick position check would miss. `pierceLeft` starts at the
  // weapon's `pierce` (targets it can hit); it despawns once that reaches 0.
  step(dt, { creatures, players, map }) {
    const killedCreatureIds = [];
    const survivors = [];
    const creatureList = creatures.all(); // hoisted: creatures don't move during this step
    const MAX_SUB = 16; // px; must be < the smallest capture radius (radius+targetHalf)
    for (const p of this.projectiles) {
      const speed = Math.hypot(p.vx, p.vy);
      let dead = !(speed > 0) || !Number.isFinite(speed) || !Number.isFinite(p.x) || !Number.isFinite(p.y);
      const ux = speed === 0 ? 0 : p.vx / speed;
      const uy = speed === 0 ? 0 : p.vy / speed;
      let moveLeft = speed * dt;

      while (moveLeft > 0 && !dead) {
        const stepDist = Math.min(MAX_SUB, moveLeft);
        p.x += ux * stepDist; p.y += uy * stepDist;
        p.remaining -= stepDist; moveLeft -= stepDist;

        // Terrain: walls stop projectiles.
        if (!map.isWalkable(p.x, p.y)) { dead = true; break; }

        // Creatures.
        for (const c of creatureList) {
          const key = `c:${c.id}`;
          if (p.hitIds.has(key)) continue;
          const half = c.width / 2;
          const cx = c.x + half, cy = c.y + c.height / 2;
          const rr = p.radius + half;
          if (dist2(p.x, p.y, cx, cy) <= rr * rr) {
            p.hitIds.add(key);
            if (creatures.damageCreatureById(c.id, p.damage)) killedCreatureIds.push(c.id);
            p.pierceLeft -= 1;
            if (p.pierceLeft <= 0) { dead = true; break; }
          }
        }
        if (dead) break;

        // Players (never the owner).
        for (const pl of players) {
          if (pl.userId === p.ownerId) continue;
          const key = `p:${pl.userId}`;
          if (p.hitIds.has(key)) continue;
          const half = pl.width / 2;
          const px = pl.x + half, py = pl.y + pl.height / 2;
          const rr = p.radius + half;
          if (dist2(p.x, p.y, px, py) <= rr * rr) {
            p.hitIds.add(key);
            applyDamage(pl, p.damage, p.element, pl.mit || NO_MITIGATION);
            p.pierceLeft -= 1;
            if (p.pierceLeft <= 0) { dead = true; break; }
          }
        }
        if (dead) break;

        if (p.remaining <= 0) { dead = true; break; }
      }

      if (!dead) survivors.push(p);
    }
    this.projectiles = survivors;
    return { killedCreatureIds };
  }

  snapshot() {
    return this.projectiles.map((p) => ({ id: p.id, x: p.x, y: p.y, element: p.element }));
  }

  count() { return this.projectiles.length; }
}

module.exports = { ProjectileSim };
