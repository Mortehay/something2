// Render-only store for ground items. Unlike CreatureManager there is no
// interpolation: a ground item never moves, so the server position is the
// render position.

const ITEM_SIZE = 24;

export class GroundItemManager {
  constructor() {
    this.items = new Map(); // id -> {id, typeId, x, y, width, height}
  }

  has(id) { return this.items.has(id); }
  count() { return this.items.size; }
  all() { return [...this.items.values()]; }

  applySnapshot(list) {
    const seen = new Set();
    for (const it of list || []) {
      seen.add(it.id);
      const existing = this.items.get(it.id);
      if (existing) {
        existing.x = it.x;
        existing.y = it.y;
        existing.typeId = it.typeId;
      } else {
        this.items.set(it.id, {
          id: it.id, typeId: it.typeId, x: it.x, y: it.y,
          width: ITEM_SIZE, height: ITEM_SIZE,
        });
      }
    }
    for (const id of this.items.keys()) if (!seen.has(id)) this.items.delete(id);
  }
}
