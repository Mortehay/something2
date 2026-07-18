// Render-only store for server projectiles. The server owns motion/collision;
// this smooths the ~20Hz snapshots between frames.
const LERP = 12; // higher = snappier follow

export class ProjectileManager {
  constructor() { this.projectiles = new Map(); } // id -> {id,x,y,tx,ty,element}

  applySnapshot(list) {
    const seen = new Set();
    for (const s of list || []) {
      seen.add(s.id);
      const p = this.projectiles.get(s.id);
      if (p) { p.tx = s.x; p.ty = s.y; p.element = s.element; }
      else this.projectiles.set(s.id, { id: s.id, x: s.x, y: s.y, tx: s.x, ty: s.y, element: s.element });
    }
    for (const id of this.projectiles.keys()) if (!seen.has(id)) this.projectiles.delete(id);
  }

  interpolate(dt) {
    const a = Math.min(1, LERP * dt);
    for (const p of this.projectiles.values()) {
      p.x += (p.tx - p.x) * a;
      p.y += (p.ty - p.y) * a;
    }
  }

  all() { return [...this.projectiles.values()].map((p) => ({ id: p.id, x: p.x, y: p.y, element: p.element })); }
}
