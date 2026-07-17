// Render-only creature store for the chunked world. The server (authority) owns
// creature simulation and sends a per-neighborhood snapshot ~5Hz over the
// `creatures` WS message; this class reconciles the rendered set to each
// snapshot and interpolates positions toward the latest target for smoothness.
const CREATURE_SIZE = 48;
const INTERP_RATE = 12; // higher = snappier; ~reaches target within a couple frames

export class CreatureManager {
  constructor() {
    this.creatures = new Map(); // id -> creature
  }

  has(id) { return this.creatures.has(id); }
  count() { return this.creatures.size; }
  all() { return [...this.creatures.values()]; }

  // Reconcile the rendered set to the snapshot (the full current neighborhood).
  applySnapshot(list) {
    const seen = new Set();
    for (const c of list) {
      seen.add(c.id);
      const ex = this.creatures.get(c.id);
      if (ex) {
        ex.tx = c.x; ex.ty = c.y;
        ex.facing = c.facing; ex.hp = c.hp;
        if (c.color) ex.color = c.color;
      } else {
        this.creatures.set(c.id, {
          id: c.id, type: c.type,
          x: c.x, y: c.y, tx: c.x, ty: c.y,
          width: CREATURE_SIZE, height: CREATURE_SIZE,
          facing: c.facing || 'S', hp: c.hp, color: c.color,
        });
      }
    }
    for (const id of [...this.creatures.keys()]) {
      if (!seen.has(id)) this.creatures.delete(id);
    }
  }

  // Lerp each creature toward its latest target so 5Hz snapshots render smoothly.
  interpolate(dt) {
    const k = Math.min(1, dt * INTERP_RATE);
    for (const c of this.creatures.values()) {
      c.x += (c.tx - c.x) * k;
      c.y += (c.ty - c.y) * k;
    }
  }
}
