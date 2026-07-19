// Drop-table rolling. Pure and rng-injectable so drops are deterministic under
// test; the caller supplies the rows and performs the INSERTs.

const { CREATURE_SIZE } = require('./creatures');

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
  // dead.x/dead.y are world_creatures' stored position, which is the
  // creature's TOP-LEFT corner (creatures.js center() adds half its
  // CREATURE_SIZE box) — but pickup measures from the player's CENTRE. Spawn
  // the drop at the corpse's centre so it isn't offset from where the
  // creature visibly died.
  const dropX = dead.x + CREATURE_SIZE / 2;
  const dropY = dead.y + CREATURE_SIZE / 2;
  for (const itemTypeId of rollDrops(dr.rows, rng)) {
    const ins = await pool.query(
      `INSERT INTO world_items (world_id, item_type_id, x, y, expires_at)
       VALUES ($1, $2, $3, $4, now() + ($5::int * interval '1 millisecond'))
       RETURNING id, item_type_id, x, y, expires_at`,
      [entry.worldId, itemTypeId, dropX, dropY, ttlMs],
    );
    // Straight into the sim so it appears in the next AOI broadcast rather than
    // waiting for a chunk reload.
    entry.world.groundItems.add(ins.rows);
  }
}

// The single claim path, shared by the keypress and auto-loot. One
// statement does the DELETE ... RETURNING and the player_items INSERT
// together via a CTE, so Postgres commits or rolls back both as a unit —
// there is no window where the world row is gone but the player_items row
// doesn't exist yet (or vice versa). rowCount === 1 means THIS call both
// deleted the world_items row AND granted it; rowCount 0 means it lost the
// race (another claim, or the expiry sweep, already removed the row) and
// nothing was granted. Correct without any in-memory lock — `claiming` only
// avoids wasted queries.
//
// NOTE: the query is not wrapped in a try/catch, so a DB-level failure (e.g.
// a dropped connection) rejects out of this function. server.js's `pickup`
// handler catches it; any future auto-loot caller must too.
async function claimItem(pool, entry, userId, groundItemId) {
  if (entry.claiming.has(groundItemId)) return null;
  entry.claiming.add(groundItemId);
  try {
    const r = await pool.query(
      `WITH d AS (DELETE FROM world_items WHERE id = $1 RETURNING item_type_id)
       INSERT INTO player_items (user_id, item_type_id)
       SELECT $2, item_type_id FROM d
       RETURNING id, item_type_id`,
      [groundItemId, userId],
    );
    if (r.rowCount !== 1) {
      entry.world.groundItems.remove(groundItemId); // stale row, evict
      return null;
    }
    const { id: instanceId, item_type_id: typeId } = r.rows[0];
    entry.world.groundItems.remove(groundItemId);
    const p = entry.world.getPlayer(userId);
    if (p && p.inv) p.inv.items.push({ id: instanceId, typeId }); // so a later equip validates without a reload
    return { id: instanceId, typeId };
  } finally {
    entry.claiming.delete(groundItemId);
  }
}

module.exports = { rollDrops, commitCreatureDeath, spawnDrops, claimItem };
