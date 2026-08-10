// Drop-table rolling. Pure and rng-injectable so drops are deterministic under
// test; the caller supplies the rows and performs the INSERTs.

const { CREATURE_SIZE } = require('./creatures');
const { awardXp, loadProgression } = require('../services/progressionStore.js');
const { xpForKill } = require('../services/playerStats.js');

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

// Gold amount for a creature death. `range` is {min,max} from entry.creatureGold.
// Returns 0 when the creature drops no gold (max 0 / missing range). Monotonic
// in rng so a higher roll never yields less, matching rollDrops' contract.
function rollGold(range, rng = Math.random) {
  const max = Math.max(0, Math.floor((range && range.max) || 0));
  if (max <= 0) return 0;
  const min = Math.max(0, Math.min(max, Math.floor((range && range.min) || 0)));
  return min + Math.floor(rng() * (max - min + 1));
}

// The single authoritative creature-death commit. rowCount === 1 means THIS
// call finalized the death, which is what licenses the drop roll AND the XP
// award: two damage sources reporting the same creature id in one tick cannot
// double-drop or double-pay, and a death that fails to persist grants nothing
// (so the DB never disagrees with what players received). Any future kill
// site must route through here.
//
// Runs the DELETE, the XP award and the drop roll in ONE transaction — a
// checked-out client, not the bare pool — so all three stand or fall
// together. `awardXp` takes a `SELECT ... FOR UPDATE` row lock that only
// serializes concurrent awards for the same player when it runs inside a
// real transaction (see progressionStore.js); calling it on the bare pool
// would silently lose that guarantee.
//
// `killerUserId` is `null` for a kill with no responsible player (a guard, or
// a riderless effect) — the XP branch is skipped entirely for those, not
// just zeroed, so a guard kill issues no player_progression queries at all.
//
// Returns `null` when the rowCount gate refuses (already finalized elsewhere,
// or the id never existed) — the caller must not treat that as "awarded
// nothing to a real kill", it means no kill was committed here at all.
// Otherwise returns `{ awarded, leveledUp, newLevel, progression,
// killerUserId }`, which server.js's onCreatureDeath uses to move the live
// player's pools (on level-up) and push a wire update to their socket.
async function commitCreatureDeath(pool, entry, creatureId, {
  rng = Math.random, ttlMs = 600000, killerUserId = null,
} = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      'DELETE FROM world_creatures WHERE id = $1 RETURNING type, x, y, level', [creatureId],
    );
    if (r.rowCount !== 1) {
      await client.query('ROLLBACK');
      return null;
    }
    const dead = r.rows[0];

    let progression = null;
    let leveledUp = false;
    let newLevel = null;
    let awarded = 0;
    // killerUserId stays the IN-MEMORY identity all the way through the kill
    // pipeline (world.js, projectiles.js) -- it is what getPlayer is keyed by.
    // Progression, though, is per-character (SOMET-257), so the id the XP
    // write needs is resolved here from the live player rather than threaded
    // through three more files. A killer who disconnected between the killing
    // blow and this commit has no player object and simply earns nothing,
    // which is the same outcome as before for a vanished killer.
    const killerCharacterId = killerUserId == null
      ? null
      : ((entry.world.getPlayer(killerUserId) || {}).characterId ?? null);
    if (killerCharacterId != null) {
      // Read BEFORE awardXp so the kill's XP is scaled by the killer's level
      // AT THIS MOMENT, not a value awardXp happens to re-derive. This is an
      // unlocked read (awardXp takes its own locked read right after, inside
      // the same transaction) — a small duplication forced by awardXp's
      // fixed signature (amount in, not creature level + player level), not
      // a correctness gap: the actual write is still serialized by awardXp's
      // own row lock.
      const before = await loadProgression(client, killerCharacterId);
      const amount = xpForKill(Number(dead.level) || 1, before.level);
      const award = await awardXp(client, killerCharacterId, amount, 'kill');
      progression = award.progression;
      leveledUp = award.leveledUp;
      newLevel = award.newLevel;
      awarded = award.awarded;
    }

    await spawnDrops(client, entry, dead, { rng, ttlMs });
    await client.query('COMMIT');
    return {
      awarded, leveledUp, newLevel, progression, killerUserId,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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

  // Rung-level fallback pool (SOMET-253 Task 7): a SEPARATE query, not a
  // UNION with the one above -- rollDrops is applied to each result set
  // independently, so a creature with rows in only ONE of the two tables
  // still gets that one, and a creature with rows in BOTH gets BOTH.
  // entry.behaviorDrops maps creature type NAME -> behavior_id (built by
  // loadCreatureTypes, mirroring entry.creatureTypeIds' name -> entity_type_id
  // role) -- a creature with no assigned profile (NULL behavior_id) has no
  // rung pool to query at all.
  const behaviorId = entry.behaviorDrops && entry.behaviorDrops.get(dead.type);
  const br = behaviorId != null
    ? await pool.query(
      'SELECT item_type_id, chance, min_qty, max_qty FROM behavior_drops WHERE behavior_id = $1',
      [behaviorId],
    )
    : { rows: [] };

  // dead.x/dead.y are world_creatures' stored position, which is the
  // creature's TOP-LEFT corner (creatures.js center() adds half its
  // CREATURE_SIZE box) — but pickup measures from the player's CENTRE. Spawn
  // the drop at the corpse's centre so it isn't offset from where the
  // creature visibly died.
  const dropX = dead.x + CREATURE_SIZE / 2;
  const dropY = dead.y + CREATURE_SIZE / 2;
  const droppedItemTypeIds = [...rollDrops(dr.rows, rng), ...rollDrops(br.rows, rng)];
  for (const itemTypeId of droppedItemTypeIds) {
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

  // Gold: one coin-pile ground item carrying the whole amount, when this
  // creature type has a gold range and the currency type exists.
  //
  // TYPE range wins when it is set; the RUNG range (entry.behaviorGold, the
  // behaviour's own gold_min/gold_max -- SOMET-253 Task 7) is the fallback.
  // Both `.get()` results default to a real {min:0,max:0} object (never
  // undefined) so the choice below can check `.max > 0` on the NUMBER
  // unconditionally -- `typeRange ? typeRange : rungRange` would always be
  // truthy (the object exists even when its range is empty) and never fall
  // through to the rung, silently disabling the fallback P4 depends on for
  // creatures with no gold range of their own.
  const typeRange = (entry.creatureGold && entry.creatureGold.get(dead.type)) || { min: 0, max: 0 };
  const rungRange = (entry.behaviorGold && entry.behaviorGold.get(dead.type)) || { min: 0, max: 0 };
  const goldAmt = rollGold(typeRange.max > 0 ? typeRange : rungRange, rng);
  if (goldAmt > 0 && entry.goldItemTypeId != null) {
    const gi = await pool.query(
      `INSERT INTO world_items (world_id, item_type_id, x, y, expires_at, quantity)
       VALUES ($1, $2, $3, $4, now() + ($5::int * interval '1 millisecond'), $6)
       RETURNING id, item_type_id, x, y, expires_at, quantity`,
      [entry.worldId, entry.goldItemTypeId, dropX, dropY, ttlMs, goldAmt],
    );
    entry.world.groundItems.add(gi.rows);
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
async function claimItem(pool, entry, userId, characterId, groundItemId) {
  if (entry.claiming.has(groundItemId)) return null;
  entry.claiming.add(groundItemId);
  try {
    const r = await pool.query(
      `WITH d AS (DELETE FROM world_items WHERE id = $1 RETURNING item_type_id, quantity)
       INSERT INTO player_items (character_id, item_type_id, quantity)
       SELECT $2, item_type_id, quantity FROM d
       RETURNING id, item_type_id, quantity`,
      [groundItemId, characterId],
    );
    if (r.rowCount !== 1) {
      entry.world.groundItems.remove(groundItemId); // stale row, evict
      return null;
    }
    const { id: instanceId, item_type_id: typeId, quantity } = r.rows[0];
    // `quantity` is ALWAYS present and always a number. world_items.quantity is
    // NOT NULL DEFAULT 1, so the `?? 1` is a floor for callers with partial
    // rows (tests), not a real production branch. Deliberately NOT conditional:
    // omitting the key when the row lacks one would let a future RETURNING that
    // stopped selecting quantity silently produce stack-less items instead of
    // failing — the same "loads as undefined" class of bug the catalog SELECT
    // guard exists to prevent.
    const qty = Number(quantity ?? 1);
    entry.world.groundItems.remove(groundItemId);
    const p = entry.world.getPlayer(userId);
    if (p && p.inv) p.inv.items.push({ id: instanceId, typeId, quantity: qty }); // so a later equip validates without a reload
    return { id: instanceId, typeId, quantity: qty };
  } finally {
    entry.claiming.delete(groundItemId);
  }
}

// Gold pickup: the currency path parallel to claimItem. One statement DELETEs
// the world_items row and credits users.gold, so there is no window where the
// row is gone but the wallet hasn't moved. rowCount === 1 means THIS call both
// removed the row and credited it; 0 means it lost the race (already claimed or
// swept) and nothing was credited. Returns the NEW balance so the caller can
// push a wallet update to the owner.
async function claimGold(pool, entry, userId, groundItemId) {
  if (entry.claiming.has(groundItemId)) return null;
  entry.claiming.add(groundItemId);
  try {
    const r = await pool.query(
      `WITH d AS (DELETE FROM world_items WHERE id = $1 RETURNING quantity)
       UPDATE users SET gold = gold + (SELECT quantity FROM d)
       WHERE id = $2 AND EXISTS (SELECT 1 FROM d)
       RETURNING gold`,
      [groundItemId, userId],
    );
    entry.world.groundItems.remove(groundItemId);
    if (r.rowCount !== 1) return null;
    const gold = Number(r.rows[0].gold) || 0;
    const p = entry.world.getPlayer(userId);
    if (p) p.gold = gold;
    return { gold };
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

async function dropItem(pool, entry, userId, characterId, itemId, { ttlMs = 600000, now = Date.now(), graceMs = DROP_GRACE_MS } = {}) {
  const p = entry.world.getPlayer(userId);
  if (!p || !p.inv) return { ok: false, reason: 'no player' };

  // Guard: dropping an equipped instance would delete the row while a
  // player_equipment row still references it, leaving a dangling paper-doll
  // entry.
  if (Object.values(p.inv.equipment).includes(itemId)) {
    return { ok: false, reason: 'unequip it first' };
  }

  const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
  // One statement does the DELETE ... RETURNING and the world_items INSERT
  // together via a CTE (mirrors claimItem), so Postgres commits or rolls
  // back both as a unit. Previously this was two independent pool.query
  // calls (two connections, two implicit transactions): a failure between
  // them — a dropped connection, a pool timeout, or world_items.world_id's
  // FK rejecting because an admin deleted the world out from under a live
  // session — committed the DELETE and never ran the INSERT, destroying the
  // item (F-016 / SOMET-196). The character_id predicate IS the ownership check —
  // a forged itemId naming someone else's item deletes (and therefore
  // inserts) nothing.
  const r = await pool.query(
    `WITH d AS (DELETE FROM player_items WHERE id = $1 AND character_id = $2 RETURNING item_type_id, quantity)
     INSERT INTO world_items (world_id, item_type_id, x, y, expires_at, quantity)
     SELECT $3, item_type_id, $4, $5, now() + ($6::int * interval '1 millisecond'), quantity FROM d
     RETURNING id, item_type_id, x, y, expires_at, quantity`,
    [itemId, characterId, entry.worldId, cx, cy, ttlMs],
  );
  if (r.rowCount !== 1) return { ok: false, reason: 'you do not own that item' };

  entry.world.groundItems.add(r.rows);
  // Bound p.dropGrace: entries only get pruned opportunistically when looked
  // up by dropGraceActive (i.e. while the item is still in pickup range), so
  // an item dropped with auto-loot off, or one the player walks away from,
  // would otherwise linger for the rest of the session. Sweep expired
  // entries here, on every drop, so the map tracks at most a few seconds'
  // worth of recent drops regardless of how auto-loot is used.
  for (const [id, exp] of p.dropGrace) {
    if (exp <= now) p.dropGrace.delete(id);
  }
  p.dropGrace.set(r.rows[0].id, now + graceMs);
  p.inv.items = p.inv.items.filter((it) => it.id !== itemId);
  return { ok: true, item: r.rows[0] };
}

module.exports = {
  rollDrops, rollGold, commitCreatureDeath, spawnDrops, claimItem, claimGold, dropItem, dropGraceActive, DROP_GRACE_MS,
};
