// Drop-table rolling. Pure and rng-injectable so drops are deterministic under
// test; the caller supplies the rows and performs the INSERTs.

// Upper bound on a single row's rolled quantity. The DB only constrains
// min_qty <= max_qty (CHECK (min_qty >= 1 AND max_qty >= min_qty)) — nothing
// stops a bad catalog row (min_qty and/or max_qty) from being huge, which
// would push a huge number of entries into `out` and hang/OOM the process.
// Applied to the final rolled quantity (not to `min`/`max` individually), so
// both an oversized max_qty AND an oversized min_qty clamp to something
// finite, and rng is still monotonic (a higher rng never yields fewer items).
const MAX_DROP_QTY = 100;

// Roll each drop row independently. Returns one item_type_id per unit of
// quantity (no stacking this slice — every drop is its own instance).
function rollDrops(dropRows, rng = Math.random) {
  const out = [];
  for (const row of dropRows || []) {
    // `chance` is a numeric column, which pg returns as a string.
    const chance = Number(row.chance);
    if (!Number.isFinite(chance) || chance <= 0) continue;
    if (rng() >= chance) continue;
    const min = Math.max(1, Number(row.min_qty) || 1);
    const max = Math.max(min, Number(row.max_qty) || min);
    const qty = Math.min(MAX_DROP_QTY, min + Math.floor(rng() * (max - min + 1)));
    for (let i = 0; i < qty; i++) out.push(row.item_type_id);
  }
  return out;
}

// The single authoritative creature-death commit. rowCount === 1 means THIS
// call finalized the death, which is what licenses the drop roll: two damage
// sources reporting the same creature id in one tick cannot double-drop, and a
// death that fails to persist drops nothing (so the DB never disagrees with
// what players received). Any future kill site must route through here.
async function commitCreatureDeath(pool, entry, creatureId, { rng = Math.random, ttlMs = 600000 } = {}) {
  const r = await pool.query(
    'DELETE FROM world_creatures WHERE id = $1 RETURNING type, x, y', [creatureId],
  );
  if (r.rowCount !== 1) return;
  await spawnDrops(pool, entry, r.rows[0], { rng, ttlMs });
}

async function spawnDrops(pool, entry, dead, { rng = Math.random, ttlMs = 600000 } = {}) {
  // world_creatures.type stores the entity type NAME; creature_drops keys on
  // entity_type_id. entry.creatureTypeIds is built at world load, so this costs
  // no query. An unknown name yields no drops rather than throwing.
  const entityTypeId = entry.creatureTypeIds.get(dead.type);
  if (entityTypeId == null) return;
  const dr = await pool.query(
    'SELECT item_type_id, chance, min_qty, max_qty FROM creature_drops WHERE entity_type_id = $1',
    [entityTypeId],
  );
  for (const itemTypeId of rollDrops(dr.rows, rng)) {
    const ins = await pool.query(
      `INSERT INTO world_items (world_id, item_type_id, x, y, expires_at)
       VALUES ($1, $2, $3, $4, now() + ($5::int * interval '1 millisecond'))
       RETURNING id, item_type_id, x, y, expires_at`,
      [entry.worldId, itemTypeId, dead.x, dead.y, ttlMs],
    );
    // Straight into the sim so it appears in the next AOI broadcast rather than
    // waiting for a chunk reload.
    entry.world.groundItems.add(ins.rows);
  }
}

// The single claim path, shared by the keypress and auto-loot. The
// DELETE ... RETURNING is the race resolution: two players grabbing the same
// item in one tick both issue it, Postgres serialises them, and exactly one
// gets rowCount 1. Correct without any in-memory lock — `claiming` only
// avoids wasted queries.
async function claimItem(pool, entry, userId, groundItemId) {
  if (entry.claiming.has(groundItemId)) return null;
  entry.claiming.add(groundItemId);
  try {
    const del = await pool.query(
      'DELETE FROM world_items WHERE id = $1 RETURNING item_type_id', [groundItemId],
    );
    if (del.rowCount !== 1) {
      entry.world.groundItems.remove(groundItemId); // stale row, evict
      return null;
    }
    const typeId = del.rows[0].item_type_id;
    // Ordering matters: the world row is already gone, so if this INSERT
    // throws the item is destroyed rather than duplicated. Losing one drop
    // is the acceptable failure; duplicating it is not.
    let instanceId = null;
    try {
      const ins = await pool.query(
        'INSERT INTO player_items (user_id, item_type_id) VALUES ($1, $2) RETURNING id',
        [userId, typeId],
      );
      instanceId = ins.rows[0].id;
    } catch (err) {
      console.error('claim lost the item (player_items insert failed):', err);
      entry.world.groundItems.remove(groundItemId);
      return null;
    }
    entry.world.groundItems.remove(groundItemId);
    const p = entry.world.getPlayer(userId);
    if (p && p.inv) p.inv.items.push({ id: instanceId, typeId }); // so a later equip validates without a reload
    return { id: instanceId, typeId };
  } finally {
    entry.claiming.delete(groundItemId);
  }
}

module.exports = { rollDrops, commitCreatureDeath, spawnDrops, claimItem };
