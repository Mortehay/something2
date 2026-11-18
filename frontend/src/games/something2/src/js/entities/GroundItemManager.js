// Render-only store for ground items. Unlike CreatureManager there is no
// interpolation: a ground item never moves, so the server position is the
// render position.

const ITEM_SIZE = 24;
const EMPTY = Object.freeze([]);

export class GroundItemManager {
  constructor() {
    this.items = new Map(); // id -> {id, typeId, x, y, width, height, rarity}
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
        // SOMET-490: updated on the EXISTING branch too, not only on create.
        // The server re-sends every neighbourhood item on a fixed cadence, so
        // an item is created once and updated forever after; a rarity written
        // only in the else-branch would still be correct today by accident and
        // wrong the first time a re-read supplies a grade the create missed.
        existing.rarity = it.rarity;
        // The loot filter's level / affix conditions (wire fields `lv` and `ax`; absent = a plain item).
        existing.itemLevel = it.lv || 1;
        existing.affixIds = it.ax || EMPTY;
        existing._lfVersion = -1; // re-evaluate: the server may have re-read the item
      } else {
        this.items.set(it.id, {
          id: it.id, typeId: it.typeId, x: it.x, y: it.y,
          width: ITEM_SIZE, height: ITEM_SIZE, rarity: it.rarity,
          itemLevel: it.lv || 1, affixIds: it.ax || EMPTY,
        });
      }
    }
    for (const id of this.items.keys()) if (!seen.has(id)) this.items.delete(id);
  }
}
