// Render-only creature store for the chunked world. The server (authority) owns
// creature simulation and sends a per-neighborhood snapshot ~5Hz over the
// `creatures` WS message; this class reconciles the rendered set to each
// snapshot and interpolates positions toward the latest target for smoothness.
const CREATURE_SIZE = 48;
const INTERP_RATE = 12; // higher = snappier; ~reaches target within a couple frames

export class CreatureManager {
  // `entityTypes` (name -> entity type def) is optional: when supplied, each
  // creature is decorated with its type's visuals (render_mode + generated
  // image/sprite) so the renderer can draw the approved sprite instead of a
  // flat colored box. Without it, creatures render exactly as before.
  constructor(entityTypes = null) {
    this.creatures = new Map(); // id -> creature
    this.entityTypes = entityTypes;
  }

  // Copy the type's visual fields onto a creature. The sprite descriptor is
  // shared by reference on purpose — Game.preloadSprites attaches `manifest`
  // to that same object after the atlas loads, which must light up creatures
  // that were created before the load finished.
  _applyTypeVisuals(creature) {
    const def = this.entityTypes && this.entityTypes[creature.type];
    if (!def) return creature;
    // Two shapes reach this: /api/entity-types rows (snake_case) and
    // /api/map/config's entityTypes map (camelCase). Accept either.
    creature.render_mode = def.render_mode || def.renderMode;
    creature.image = def.image || null;
    creature.sprite = def.sprite || null;
    const w = def.display_width || def.displayWidth;
    const h = def.display_height || def.displayHeight;
    if (w) creature.displayWidth = w;
    if (h) creature.displayHeight = h;
    return creature;
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
        ex.facing = c.facing; ex.hp = c.hp; ex.maxHp = c.maxHp; ex.mode = c.mode;
        // Assigned UNCONDITIONALLY (unlike color below): the server omits the
        // field entirely once nothing is active, so a `if (c.effects)` guard
        // would leave the last tint stuck on the creature forever.
        ex.effects = c.effects || null;
        if (c.color) ex.color = c.color;
      } else {
        this.creatures.set(c.id, this._applyTypeVisuals({
          id: c.id, type: c.type,
          x: c.x, y: c.y, tx: c.x, ty: c.y,
          width: CREATURE_SIZE, height: CREATURE_SIZE,
          facing: c.facing || 'S', hp: c.hp, maxHp: c.maxHp, mode: c.mode, color: c.color,
          effects: c.effects || null,
        }));
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
