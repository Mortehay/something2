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
    creature.place_order = def.place_order || 0;
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
  //
  // SOMET-354. Records are now PARTIAL, in two independent ways, and the
  // difference between "omitted" and "cleared" is the whole correctness
  // question here:
  //
  //   - The immutable fields (type/color/maxHp/level) arrive ONCE, on the frame
  //     that first shows a creature to this socket. Every later frame omits
  //     them, so they must be merged, never overwritten with undefined. The
  //     server rebuilds its per-socket "already told" set from the ids it
  //     actually sent, so a creature that leaves the neighbourhood and returns
  //     is re-introduced in full -- which is exactly the case the delete loop
  //     at the bottom creates, and why re-arrival cannot land as a bare
  //     position with no type.
  //
  //   - A record marked `f` is FAR: outside the detail zone, carried only so
  //     the minimap can keep drawing its dot. It has position and nothing else.
  //     `facing`/`hp`/`mode`/`effects` are absent because they were not sent,
  //     NOT because they became empty, so the previous values are held. Without
  //     the `f` flag this is indistinguishable from a near creature whose
  //     effects just expired -- and effects are assigned unconditionally for
  //     near creatures precisely so an expired one disappears.
  applySnapshot(list) {
    const seen = new Set();
    for (const c of list) {
      seen.add(c.id);
      const ex = this.creatures.get(c.id);
      if (ex) {
        ex.tx = c.x; ex.ty = c.y;
        if (!c.f) {
          ex.facing = c.facing; ex.hp = c.hp; ex.mode = c.mode;
          // Assigned UNCONDITIONALLY within the near zone (unlike color
          // below): the server omits the field entirely once nothing is
          // active, so a `if (c.effects)` guard would leave the last tint
          // stuck on the creature forever.
          ex.effects = c.effects || null;
        }
        // Immutable fields: present only on a re-introduction. `!== undefined`
        // rather than truthiness -- level 0 and maxHp 0 are real values, and a
        // truthiness test would silently decline to apply them.
        if (c.maxHp !== undefined) ex.maxHp = c.maxHp;
        if (c.level !== undefined) ex.level = c.level;
        if (c.color) ex.color = c.color;
      } else {
        this.creatures.set(c.id, this._applyTypeVisuals({
          id: c.id, type: c.type,
          x: c.x, y: c.y, tx: c.x, ty: c.y,
          width: CREATURE_SIZE, height: CREATURE_SIZE,
          // A first sighting in the FAR zone carries position and the
          // immutable fields, but no facing/hp/mode -- it has never been close
          // enough to have any. The defaults keep it a well-formed creature
          // (the minimap needs only x/y/color; the renderer needs a facing) and
          // the first near frame replaces them with real values.
          facing: c.facing || 'S',
          hp: c.hp !== undefined ? c.hp : c.maxHp,
          maxHp: c.maxHp, mode: c.mode || 'idle', color: c.color,
          level: c.level,
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
