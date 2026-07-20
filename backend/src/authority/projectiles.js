// Server-simulated projectiles (arrows, magic bolts, …). Transient in-memory
// only — never persisted, no randomness. Collides with terrain, creatures, and
// players (never the owner). Ranged and magic share this one path; they differ
// only by weapon data.

const { applyDamage, NO_MITIGATION } = require('./damage');
const { hasLineOfSight } = require('./weapons');
const { applyElementEffect } = require('./effects');

// Sub-step resolution for terrain sampling, shared with the melee
// line-of-sight walk in weapons.js. Defined in subStep.js (see the note there
// on why it cannot live in either consumer) and re-exported here, which is
// where callers have always imported it from.
const { MAX_SUB } = require('./subStep');

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
      // null = today's point-collision projectile, unchanged. Normalized here
      // so a 0/negative/non-finite radius can never reach the falloff division.
      aoeRadius: weapon.aoe_radius > 0 ? weapon.aoe_radius : null,
      element: weapon.element ?? null,
      hitIds: new Set(), // 'c:<id>' / 'p:<id>' already hit by this projectile
    });
    return id;
  }

  // Resolve an AoE blast at (bx,by). Damages every creature and every
  // non-owner player within `radius`, scaled linearly from full damage at the
  // centre to zero at the edge.
  //
  // Each candidate needs line of sight FROM THE BLAST POINT: without it AoE
  // reintroduces the melee-through-walls exploit closed in 3b-3a, with a
  // bigger hitbox. Reuses the same helper and the same shared MAX_SUB.
  //
  // The caster is exempt, matching the existing rule that a projectile never
  // collides with its owner — one rule, not two.
  _detonate(p, bx, by, { creatureList, creatures, players, map, now }, killedCreatureIds) {
    const r = p.aoeRadius;
    for (const c of creatureList) {
      const half = c.width / 2;
      const cx = c.x + half, cy = c.y + c.height / 2;
      const d = Math.hypot(cx - bx, cy - by);
      if (d >= r) continue;
      if (!hasLineOfSight(map, bx, by, cx, cy)) continue;
      // Falloff scales the RAW damage; the creature's own defense and
      // resistances are applied on top, inside damageCreatureById.
      if (creatures.damageCreatureById(c.id, p.damage * (1 - d / r), p.element)) {
        killedCreatureIds.push(c.id);
      }
      // The rider is applied at FULL duration: falloff scales damage only. A
      // target clipped by the blast edge still burns for the full time —
      // scaling the duration too would give it a burn too short to ever tick.
      applyElementEffect(c, p.element, now, p.ownerId);
    }
    for (const pl of players) {
      if (pl.userId === p.ownerId) continue;
      const half = pl.width / 2;
      const px = pl.x + half, py = pl.y + pl.height / 2;
      const d = Math.hypot(px - bx, py - by);
      if (d >= r) continue;
      if (!hasLineOfSight(map, bx, by, px, py)) continue;
      // Falloff scales the RAW damage; applyDamage still applies defense and
      // resistances on top. It floors at 1, so an edge hit still registers.
      applyDamage(pl, p.damage * (1 - d / r), p.element, pl.mit || NO_MITIGATION);
      applyElementEffect(pl, p.element, now, p.ownerId);
    }
    return { x: bx, y: by, radius: r, element: p.element };
  }

  // Advance every projectile one tick; resolve terrain, creature, and player
  // collisions. Returns the creature ids killed this step (for the caller to
  // DELETE) and the AoE blasts that went off (for the caller to broadcast).
  //
  // An AoE projectile detonates on its FIRST contact of ANY kind — terrain, a
  // creature, a player, or running out of range — instead of applying the
  // single-target hit. Exactly one detonation per projectile: every path that
  // sets `dead` for an impact detonates, and `dead` ends the walk.
  //
  // Movement is SUB-STEPPED in <=MAX_SUB px increments so a fast projectile
  // cannot tunnel through a target within a single tick: a bow (900 px/s) moves
  // ~45 px per 20 Hz tick, larger than a creature's ~32 px capture radius, so a
  // single end-of-tick position check would miss. `pierceLeft` starts at the
  // weapon's `pierce` (targets it can hit); it despawns once that reaches 0.
  step(dt, { creatures, players, map, now = 0 }) {
    const killedCreatureIds = [];
    const detonations = [];
    const survivors = [];
    const creatureList = creatures.all(); // hoisted: creatures don't move during this step
    const ctx = { creatureList, creatures, players, map, now };
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
        if (!map.isWalkable(p.x, p.y)) {
          if (p.aoeRadius) detonations.push(this._detonate(p, p.x, p.y, ctx, killedCreatureIds));
          dead = true; break;
        }

        // Creatures.
        for (const c of creatureList) {
          const key = `c:${c.id}`;
          if (p.hitIds.has(key)) continue;
          const half = c.width / 2;
          const cx = c.x + half, cy = c.y + c.height / 2;
          const rr = p.radius + half;
          if (dist2(p.x, p.y, cx, cy) <= rr * rr) {
            if (p.aoeRadius) {
              detonations.push(this._detonate(p, p.x, p.y, ctx, killedCreatureIds));
              dead = true; break;
            }
            p.hitIds.add(key);
            if (creatures.damageCreatureById(c.id, p.damage, p.element)) killedCreatureIds.push(c.id);
            applyElementEffect(c, p.element, now, p.ownerId);
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
            if (p.aoeRadius) {
              detonations.push(this._detonate(p, p.x, p.y, ctx, killedCreatureIds));
              dead = true; break;
            }
            p.hitIds.add(key);
            applyDamage(pl, p.damage, p.element, pl.mit || NO_MITIGATION);
            applyElementEffect(pl, p.element, now, p.ownerId);
            p.pierceLeft -= 1;
            if (p.pierceLeft <= 0) { dead = true; break; }
          }
        }
        if (dead) break;

        // Out of range counts as an impact: a fireball that reaches the end of
        // its flight without touching anything still explodes.
        if (p.remaining <= 0) {
          if (p.aoeRadius) detonations.push(this._detonate(p, p.x, p.y, ctx, killedCreatureIds));
          dead = true; break;
        }
      }

      if (!dead) survivors.push(p);
    }
    this.projectiles = survivors;
    return { killedCreatureIds, detonations };
  }

  snapshot() {
    return this.projectiles.map((p) => ({ id: p.id, x: p.x, y: p.y, element: p.element }));
  }

  count() { return this.projectiles.length; }
}

module.exports = { ProjectileSim, MAX_SUB };
