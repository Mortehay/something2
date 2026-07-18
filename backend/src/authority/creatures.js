// Server-side creature roaming — a port of the client CreatureManager roam
// logic (frontend/.../entities/CreatureManager.js), driven by the authority's
// active chunk set. Positions are world-space; active/AOI/prune key on the
// creature's CURRENT chunk (chunkOf), never its spawn chunk.
const { resolveMove } = require('./collision');
const { chunkOf, CHUNK_KEY } = require('./coords');
const { inArc } = require('./weapons');

const DIRS = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];
const DIR_FACING = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
const CREATURE_SIZE = 48;
const CREATURE_SPEED = 40;    // world px/s
const REDIRECT_CHANCE = 0.02;

const AGGRO_RADIUS = 400;            // px: acquire nearest player within this
const LEASH_RADIUS = 800;            // px: drop a target beyond this
const CONTACT_RANGE = 60;            // px: creature may hit its target within this
const CREATURE_DAMAGE = 5;
const CREATURE_ATTACK_COOLDOWN = 1.0; // s

function center(o) { return { x: o.x + o.width / 2, y: o.y + o.height / 2 }; }
function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }
// Nearest DIRS index for a movement vector's signs → facing.
function facingFor(vx, vy) {
  const sx = Math.sign(vx), sy = Math.sign(vy);
  for (let i = 0; i < DIRS.length; i++) if (DIRS[i][0] === sx && DIRS[i][1] === sy) return DIR_FACING[i];
  return null;
}

class CreatureSim {
  constructor(map, rng = Math.random) {
    this.map = map;
    this.rng = rng;
    this.chunkSize = map.chunkSize;
    this.creatures = new Map(); // id -> creature
  }

  addCreatures(list) {
    for (const c of list) {
      if (this.creatures.has(c.id)) continue;
      const dirIdx = Math.min(DIRS.length - 1, Math.floor(this.rng() * DIRS.length));
      this.creatures.set(c.id, {
        id: c.id, type: c.type, x: c.x, y: c.y,
        width: CREATURE_SIZE, height: CREATURE_SIZE, speed: CREATURE_SPEED,
        facing: c.facing || 'S', hp: c.hp, maxHp: c.hp, color: c.color,
        _dir: dirIdx, dirty: false,
        _target: null, mode: 'roam', _attackCd: 0,
      });
    }
  }

  has(id) { return this.creatures.has(id); }
  count() { return this.creatures.size; }
  all() { return [...this.creatures.values()]; }

  tick(dt, activeChunkKeys, players = []) {
    const active = activeChunkKeys instanceof Set ? activeChunkKeys : new Set(activeChunkKeys);
    const byId = new Map(players.map((p) => [p.userId, p]));
    for (const c of this.creatures.values()) {
      const { cx, cy } = chunkOf(c.x, c.y, this.chunkSize);
      if (!active.has(CHUNK_KEY(cx, cy))) continue; // frozen (out of active set)
      if (c._attackCd > 0) c._attackCd = Math.max(0, c._attackCd - dt);

      const cc = center(c);
      // Target resolution: keep current target unless it left leash; else acquire nearest in aggro.
      if (c._target) {
        const tp = byId.get(c._target);
        if (!tp || dist2(cc.x, cc.y, center(tp).x, center(tp).y) > LEASH_RADIUS * LEASH_RADIUS) c._target = null;
      }
      if (!c._target) {
        let nearest = null, nd2 = AGGRO_RADIUS * AGGRO_RADIUS;
        for (const p of players) {
          const pc = center(p);
          const d2 = dist2(cc.x, cc.y, pc.x, pc.y);
          if (d2 <= nd2) { nd2 = d2; nearest = p; }
        }
        if (nearest) c._target = nearest.userId;
      }
      c.mode = c._target ? 'chase' : 'roam';

      if (c.mode === 'chase') {
        const tp = byId.get(c._target);
        const tc = center(tp);
        const vx = tc.x - cc.x, vy = tc.y - cc.y;
        const r = resolveMove(this.map, c, vx, vy, dt);
        if (r.x !== c.x || r.y !== c.y) {
          c.x = r.x; c.y = r.y;
          const f = facingFor(vx, vy); if (f) c.facing = f;
          c.dirty = true;
        }
        // Contact damage.
        if (c._attackCd <= 0 && dist2(cc.x, cc.y, tc.x, tc.y) <= CONTACT_RANGE * CONTACT_RANGE) {
          tp.hp -= CREATURE_DAMAGE;
          c._attackCd = CREATURE_ATTACK_COOLDOWN;
        }
        continue;
      }

      // Roam (unchanged behavior).
      if (this.rng() < REDIRECT_CHANCE) {
        c._dir = Math.min(DIRS.length - 1, Math.floor(this.rng() * DIRS.length));
      }
      const [dx, dy] = DIRS[c._dir];
      const r = resolveMove(this.map, c, dx, dy, dt);
      if (r.x !== c.x || r.y !== c.y) {
        c.x = r.x; c.y = r.y;
        c.facing = DIR_FACING[c._dir];
        c.dirty = true;
      } else {
        c._dir = (c._dir + 1) % DIRS.length; // blocked → turn
      }
    }
  }

  // Player melee: damage creatures within `range` of (px,py); remove + return dead ids.
  applyAttack(px, py, range, damage) {
    const killed = [];
    const r2 = range * range;
    for (const [id, c] of this.creatures) {
      const cc = center(c);
      if (dist2(cc.x, cc.y, px, py) > r2) continue;
      c.hp -= damage;
      c.dirty = true;
      if (c.hp <= 0) { this.creatures.delete(id); killed.push(id); }
    }
    return killed;
  }

  // Melee arc: damage every creature whose center is within reach AND inside the
  // aim cone; remove + return the dead ids. (nx,ny) must be normalized.
  applyMeleeArc(ox, oy, nx, ny, reach, arcWidth, damage) {
    const killed = [];
    for (const [id, c] of this.creatures) {
      const cc = center(c);
      if (!inArc(ox, oy, nx, ny, cc.x, cc.y, reach, arcWidth)) continue;
      c.hp -= damage;
      c.dirty = true;
      if (c.hp <= 0) { this.creatures.delete(id); killed.push(id); }
    }
    return killed;
  }

  // Point damage to one creature (used by projectile collision). Returns true
  // if it died (and was removed).
  damageCreatureById(id, damage) {
    const c = this.creatures.get(id);
    if (!c) return false;
    c.hp -= damage;
    c.dirty = true;
    if (c.hp <= 0) { this.creatures.delete(id); return true; }
    return false;
  }

  getDirty() {
    const out = [];
    for (const c of this.creatures.values()) {
      if (c.dirty) out.push({ id: c.id, x: c.x, y: c.y, facing: c.facing });
    }
    return out;
  }

  clearDirty(ids) {
    for (const id of ids) {
      const c = this.creatures.get(id);
      if (c) c.dirty = false;
    }
  }

  // Drop non-dirty creatures whose current chunk left the active set. Dirty
  // creatures are kept until a flush clears them (confirm-before-drop), so no
  // unpersisted position is lost. Returns the number dropped.
  pruneInactive(activeChunkKeys) {
    const active = activeChunkKeys instanceof Set ? activeChunkKeys : new Set(activeChunkKeys);
    let dropped = 0;
    for (const [id, c] of this.creatures) {
      const { cx, cy } = chunkOf(c.x, c.y, this.chunkSize);
      if (active.has(CHUNK_KEY(cx, cy))) continue;
      if (c.dirty) continue;
      this.creatures.delete(id);
      dropped++;
    }
    return dropped;
  }

  snapshotForNeighborhood(keys) {
    const set = keys instanceof Set ? keys : new Set(keys);
    const out = [];
    for (const c of this.creatures.values()) {
      const { cx, cy } = chunkOf(c.x, c.y, this.chunkSize);
      if (set.has(CHUNK_KEY(cx, cy))) {
        out.push({ id: c.id, type: c.type, x: c.x, y: c.y, facing: c.facing, hp: c.hp, maxHp: c.maxHp, mode: c.mode, color: c.color });
      }
    }
    return out;
  }
}

module.exports = {
  CreatureSim, CREATURE_SIZE, CREATURE_SPEED, REDIRECT_CHANCE,
  AGGRO_RADIUS, LEASH_RADIUS, CONTACT_RANGE, CREATURE_DAMAGE, CREATURE_ATTACK_COOLDOWN,
};
