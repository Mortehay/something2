// Ground items: dropped loot lying in the world. Deliberately mirrors
// CreatureSim's surface so the two read alike — but a ground item's position
// never changes, so there is no dirty set and no confirm-before-drop. Its only
// mutable property is existence, and the database already records that.

const { chunkOf, CHUNK_KEY } = require('./coords');

// The four grades world_items.rarity's CHECK constraint admits (SOMET-480).
// Anything else -- a row from before that migration, a gold pile whose INSERT
// never named the column, a typo -- normalises to 'white', which is both the
// column's DB default and the grade the client draws with no glow at all. That
// keeps "unknown grade" and "ordinary item" the same pixel, rather than
// leaving `undefined` to travel the wire and become a client-side branch.
const RARITY_GRADES = new Set(['white', 'blue', 'yellow', 'foxy']);

function normalizeRarity(v) {
  return RARITY_GRADES.has(v) ? v : 'white';
}

const PICKUP_RADIUS = 80; // == the dagger's seeded reach: you can only loot what you could hit

class GroundItemSim {
  constructor(chunkSize) {
    this.chunkSize = chunkSize;
    this.items = new Map(); // id -> {id, typeId, x, y, expiresAt, rarity}
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
        // SOMET-490. Held here rather than looked up at snapshot time because
        // this Map is the ONLY copy of a ground item the broadcast can see:
        // pruneInactive forgets the entry when its chunk deactivates and
        // activateChunk re-SELECTs it, so a grade that is not carried on BOTH
        // that re-read and this add silently reverts to white when a player
        // walks away and comes back.
        rarity: normalizeRarity(r.rarity),
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

  // SOMET-482: returns {id, x, y} per removed item, NOT a bare id list.
  //
  // The position is the whole point of the return value now: server.js
  // broadcasts a despawn puff at each expired item's position, and once the
  // entry is deleted from this.items there is nowhere left to look it up.
  // Reading x/y BEFORE the delete is the only order that works.
  removeExpired(nowMs) {
    const removed = [];
    for (const [id, it] of this.items) {
      if (it.expiresAt <= nowMs) {
        removed.push({ id, x: it.x, y: it.y });
        this.items.delete(id);
      }
    }
    return removed;
  }

  snapshotForNeighborhood(keys) {
    const set = keys instanceof Set ? keys : new Set(keys);
    const out = [];
    for (const it of this.items.values()) {
      const { cx, cy } = chunkOf(it.x, it.y, this.chunkSize);
      if (set.has(CHUNK_KEY(cx, cy))) {
        out.push({ id: it.id, typeId: it.typeId, x: it.x, y: it.y, rarity: it.rarity });
      }
    }
    return out;
  }
}

module.exports = { GroundItemSim, PICKUP_RADIUS, RARITY_GRADES };
