import { chunkOf, CHUNK_KEY } from "../core/worldCoords.js";
import { resolveMove } from "../systems/movement.js";

// 8 wander directions (dx,dy) in world space.
const DIRS = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];
const DIR_FACING = ["E", "SE", "S", "SW", "W", "NW", "N", "NE"];
const CREATURE_SIZE = 48;
const CREATURE_SPEED = 40;       // world px/s (slower than the player)
const REDIRECT_CHANCE = 0.02;    // per update, chance to pick a new wander dir

export class CreatureManager {
  constructor(chunkSize, rng = Math.random) {
    this.chunkSize = chunkSize;
    this.rng = rng;
    this.creatures = new Map(); // id -> creature
  }

  addCreatures(list) {
    for (const c of list) {
      if (this.creatures.has(c.id)) continue;
      const dirIdx = Math.min(DIRS.length - 1, Math.floor(this.rng() * DIRS.length));
      this.creatures.set(c.id, {
        id: c.id, type: c.type, x: c.x, y: c.y,
        width: CREATURE_SIZE, height: CREATURE_SIZE,
        speed: CREATURE_SPEED, facing: c.facing || "S", hp: c.hp,
        color: c.color,
        _dir: dirIdx, dirty: false,
      });
    }
  }

  has(id) { return this.creatures.has(id); }
  count() { return this.creatures.size; }
  all() { return [...this.creatures.values()]; }

  update(dt, loadedKeys, chunkedMap) {
    const loaded = loadedKeys instanceof Set ? loadedKeys : new Set(loadedKeys);
    let roamed = 0;
    for (const c of this.creatures.values()) {
      const { cx, cy } = chunkOf(c.x, c.y, this.chunkSize);
      if (!loaded.has(CHUNK_KEY(cx, cy))) continue; // frozen (out of neighborhood)
      if (this.rng() < REDIRECT_CHANCE) {
        c._dir = Math.min(DIRS.length - 1, Math.floor(this.rng() * DIRS.length));
      }
      const [dx, dy] = DIRS[c._dir];
      const r = resolveMove(chunkedMap, c, dx, dy, dt);
      if (r.x !== c.x || r.y !== c.y) {
        c.x = r.x; c.y = r.y;
        c.facing = DIR_FACING[c._dir];
        c.dirty = true;
        roamed++;
      } else {
        // blocked -> turn for next time
        c._dir = (c._dir + 1) % DIRS.length;
      }
    }
    return roamed;
  }

  takeDirty() {
    const dirty = [];
    for (const c of this.creatures.values()) {
      if (c.dirty) {
        dirty.push({ id: c.id, x: c.x, y: c.y, facing: c.facing });
        c.dirty = false;
      }
    }
    return dirty;
  }
}
