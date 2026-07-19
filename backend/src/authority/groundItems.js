// Ground items: dropped loot lying in the world. Deliberately mirrors
// CreatureSim's surface so the two read alike — but a ground item's position
// never changes, so there is no dirty set and no confirm-before-drop. Its only
// mutable property is existence, and the database already records that.

const { chunkOf, CHUNK_KEY } = require('./coords');

const PICKUP_RADIUS = 80; // == the dagger's seeded reach: you can only loot what you could hit

class GroundItemSim {
  constructor(chunkSize) {
    this.chunkSize = chunkSize;
    this.items = new Map(); // id -> {id, typeId, x, y, expiresAt}
  }

  add(rows) {
    for (const r of rows || []) {
      if (r == null || r.id == null) continue;
      if (this.items.has(r.id)) continue; // dedup: a re-activated chunk re-SELECTs rows already held
      const expires = r.expires_at != null ? r.expires_at : r.expiresAt;
      this.items.set(r.id, {
        id: r.id,
        typeId: r.item_type_id != null ? r.item_type_id : r.typeId,
        x: Number(r.x),
        y: Number(r.y),
        expiresAt: expires != null ? new Date(expires).getTime() : Infinity,
      });
    }
  }

  remove(id) { return this.items.delete(id); }
  get(id) { return this.items.get(id) || null; }
  count() { return this.items.size; }

  within(x, y, radius) {
    const r2 = radius * radius;
    const out = [];
    for (const it of this.items.values()) {
      const dx = it.x - x, dy = it.y - y;
      if (dx * dx + dy * dy <= r2) out.push(it);
    }
    return out;
  }

  nearest(x, y, radius) {
    const r2 = radius * radius;
    let best = null, bestD = Infinity;
    for (const it of this.items.values()) {
      const dx = it.x - x, dy = it.y - y;
      const d = dx * dx + dy * dy;
      if (d <= r2 && d < bestD) { bestD = d; best = it; }
    }
    return best;
  }

  // Forget items whose chunk left the active set. Safe to drop unconditionally:
  // the DB row is untouched and a later activateChunk re-SELECTs it.
  pruneInactive(activeChunkKeys) {
    const active = activeChunkKeys instanceof Set ? activeChunkKeys : new Set(activeChunkKeys);
    let dropped = 0;
    for (const [id, it] of this.items) {
      const { cx, cy } = chunkOf(it.x, it.y, this.chunkSize);
      if (active.has(CHUNK_KEY(cx, cy))) continue;
      this.items.delete(id);
      dropped++;
    }
    return dropped;
  }

  removeExpired(nowMs) {
    const removed = [];
    for (const [id, it] of this.items) {
      if (it.expiresAt <= nowMs) { this.items.delete(id); removed.push(id); }
    }
    return removed;
  }

  snapshotForNeighborhood(keys) {
    const set = keys instanceof Set ? keys : new Set(keys);
    const out = [];
    for (const it of this.items.values()) {
      const { cx, cy } = chunkOf(it.x, it.y, this.chunkSize);
      if (set.has(CHUNK_KEY(cx, cy))) out.push({ id: it.id, typeId: it.typeId, x: it.x, y: it.y });
    }
    return out;
  }
}

module.exports = { GroundItemSim, PICKUP_RADIUS };
