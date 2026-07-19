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
    // quantity named explicitly (not left to the column default): creature
    // drops stay one-per-unit this slice, and being explicit here stops a
    // future edit from silently inheriting whatever the default happens to
    // be instead of deliberately choosing 1.
    const ins = await pool.query(
      `INSERT INTO world_items (world_id, item_type_id, x, y, expires_at, quantity)
       VALUES ($1, $2, $3, $4, now() + ($5::int * interval '1 millisecond'), $6)
       RETURNING id, item_type_id, x, y, expires_at, quantity`,
      [entry.worldId, itemTypeId, dropX, dropY, ttlMs, 1],
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
      `WITH d AS (DELETE FROM world_items WHERE id = $1 RETURNING item_type_id, quantity)
       INSERT INTO player_items (user_id, item_type_id, quantity)
       SELECT $2, item_type_id, quantity FROM d
       RETURNING id, item_type_id, quantity`,
      [groundItemId, userId],
    );
    if (r.rowCount !== 1) {
      entry.world.groundItems.remove(groundItemId); // stale row, evict
      return null;
    }
    const { id: instanceId, item_type_id: typeId, quantity } = r.rows[0];
    // Only attach `quantity` when the row actually carried one — spreading an
    // explicit `quantity: undefined` key would still show up in
    // Object.keys/deepStrictEqual, unlike a key that was never set.
    const qty = quantity !== undefined ? { quantity } : {};
    entry.world.groundItems.remove(groundItemId);
    const p = entry.world.getPlayer(userId);
    if (p && p.inv) p.inv.items.push({ id: instanceId, typeId, ...qty }); // so a later equip validates without a reload
    return { id: instanceId, typeId, ...qty };
  } finally {
    entry.claiming.delete(groundItemId);
  }
}

// How long a just-dropped ground item is exempt from ITS OWN DROPPER's
// auto-loot scan. dropItem spawns the item at the player's exact centre, so
// without this the tick's `within(pcx, pcy, PICKUP_RADIUS)` scan finds it at
// distance 0 and re-claims it inside one tick (<=50ms): the client sees
// `dropped` immediately followed by `picked` with a DIFFERENT instance id,
// the item never actually leaves the inventory, and the client's held id
// goes stale. Deliberately PER PLAYER, not global: another player standing
// on the spot with auto-loot on may still claim it instantly — the item is
// genuinely free-for-all, this only stops the dropper's own scan.
const DROP_GRACE_MS = 3000;

// True if `groundItemId` is still inside `p`'s drop-grace window as of `now`.
// Only the auto-loot tick scan should call this — a manual pickup keypress
// must always be honored regardless of grace, so `claimItem` (the shared
// claim path for both) never consults `dropGrace` itself; the caller decides
// whether grace applies before invoking it.
//
// Opportunistically prunes the entry it looks up, but that alone does not
// bound the map: an item dropped with auto-loot off, or one the player walks
// away from before its grace expires, is never looked up again and would sit
// in `dropGrace` for the rest of the session. `dropItem` is what actually
// bounds the map, by sweeping already-expired entries before every insert.
function dropGraceActive(p, groundItemId, now) {
  const exp = p.dropGrace.get(groundItemId);
  if (exp == null) return false;
  if (exp <= now) { p.dropGrace.delete(groundItemId); return false; }
  return true;
}

async function dropItem(pool, entry, userId, itemId, { ttlMs = 600000, now = Date.now(), graceMs = DROP_GRACE_MS } = {}) {
  const p = entry.world.getPlayer(userId);
  if (!p || !p.inv) return { ok: false, reason: 'no player' };

  // Guard: dropping an equipped instance would delete the row while a
  // player_equipment row still references it, leaving a dangling paper-doll
  // entry.
  if (Object.values(p.inv.equipment).includes(itemId)) {
    return { ok: false, reason: 'unequip it first' };
  }

  // The user_id predicate IS the ownership check — a forged itemId naming
  // someone else's item deletes nothing.
  const del = await pool.query(
    'DELETE FROM player_items WHERE id = $1 AND user_id = $2 RETURNING item_type_id, quantity',
    [itemId, userId],
  );
  if (del.rowCount !== 1) return { ok: false, reason: 'you do not own that item' };

  const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
  const ins = await pool.query(
    `INSERT INTO world_items (world_id, item_type_id, x, y, expires_at, quantity)
     VALUES ($1, $2, $3, $4, now() + ($5::int * interval '1 millisecond'), $6)
     RETURNING id, item_type_id, x, y, expires_at, quantity`,
    [entry.worldId, del.rows[0].item_type_id, cx, cy, ttlMs, del.rows[0].quantity],
  );
  entry.world.groundItems.add(ins.rows);
  // Bound p.dropGrace: entries only get pruned opportunistically when looked
  // up by dropGraceActive (i.e. while the item is still in pickup range), so
  // an item dropped with auto-loot off, or one the player walks away from,
  // would otherwise linger for the rest of the session. Sweep expired
  // entries here, on every drop, so the map tracks at most a few seconds'
  // worth of recent drops regardless of how auto-loot is used.
  for (const [id, exp] of p.dropGrace) {
    if (exp <= now) p.dropGrace.delete(id);
  }
  p.dropGrace.set(ins.rows[0].id, now + graceMs);
  p.inv.items = p.inv.items.filter((it) => it.id !== itemId);
  return { ok: true, item: ins.rows[0] };
}

module.exports = {
  rollDrops, commitCreatureDeath, spawnDrops, claimItem, dropItem, dropGraceActive, DROP_GRACE_MS,
};
