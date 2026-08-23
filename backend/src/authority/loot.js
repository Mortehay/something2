// Drop-table rolling. Pure and rng-injectable so drops are deterministic under
// test; the caller supplies the rows and performs the INSERTs.

const { CREATURE_SIZE } = require('./creatures');
const { hasFreeSlot } = require('./items');
const { awardXp, loadProgression } = require('../services/progressionStore.js');
const { xpForKill } = require('../services/playerStats.js');
const { RESPAWN_DELAY_MS } = require('../services/creatureRespawn');

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
      'DELETE FROM world_creatures WHERE id = $1 '
      + 'RETURNING type, x, y, level, home_x, blocks_portal_id', [creatureId],
    );
    if (r.rowCount !== 1) {
      await client.query('ROLLBACK');
      return null;
    }
    const dead = r.rows[0];

    // SOMET-309: schedule the replacement inside the SAME transaction that
    // commits this death. The header comment above establishes that the
    // delete, the XP award and the drop roll stand or fall together; the
    // respawn belongs in that set for the same reason. A kill that paid XP
    // and dropped loot but failed to queue its replacement would be a silent,
    // permanent population leak -- precisely the bug this ticket exists to fix.
    //
    // Wild creatures only. home_x is the structural marker every guard kind
    // shares (village, portal and vault guards all leash to a post via
    // home_x/home_y, and populateWorld's own wipe spares them on exactly this
    // column); blocks_portal_id catches a portal guard specifically. Guards
    // have their own lifecycles -- a vault guard is respawned by the chest
    // sweep -- and queueing them here would duplicate them.
    if (dead.home_x === null && dead.blocks_portal_id === null) {
      await client.query(
        `INSERT INTO creature_respawns (world_id, type, x, y, level, respawn_at)
         VALUES ($1,$2,$3,$4,$5, now() + ($6::int * interval '1 millisecond'))`,
        [entry.worldId, dead.type, dead.x, dead.y, dead.level, RESPAWN_DELAY_MS],
      );
    }

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
  if (droppedItemTypeIds.length) {
    // SOMET-96: ONE multi-row INSERT, not an awaited INSERT per dropped unit.
    // Bounded by MAX_DROP_QTY and off the tick path, so this was never urgent
    // -- but a creature dropping its cap previously cost that many sequential
    // round trips, each holding a pool connection, and every one of them could
    // fail independently and leave a partial pile on the ground.
    //
    // UNNEST rather than building "($1,$2),($3,$4),..." by hand: the value
    // list stays three bound parameters regardless of drop count, so there is
    // no string-built SQL to get wrong and no parameter-count ceiling to trip
    // over if MAX_DROP_QTY is ever raised.
    //
    // quantity is named explicitly (not left to the column default): creature
    // drops stay one-per-unit this slice, and being explicit stops a future
    // edit from silently inheriting whatever the default happens to be.
    const ins = await pool.query(
      `INSERT INTO world_items (world_id, item_type_id, x, y, expires_at, quantity)
       SELECT $1, t.item_type_id, $2, $3, now() + ($4::int * interval '1 millisecond'), 1
         FROM unnest($5::int[]) AS t(item_type_id)
       RETURNING id, item_type_id, x, y, expires_at, quantity`,
      [entry.worldId, dropX, dropY, ttlMs, droppedItemTypeIds],
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

// Put a bare list of item TYPE ids on the ground at (x, y). The one thing
// spawnDrops cannot do: it rolls a dead creature's drop table, whereas this
// takes ids the caller already decided on -- today, chest loot that would not
// fit in the opener's inventory (SOMET-464). Same INSERT shape and the same
// straight-into-the-sim add as spawnDrops, so the items appear in the next AOI
// broadcast rather than waiting for a chunk reload.
async function spawnGroundItemTypes(pool, entry, itemTypeIds, x, y, { ttlMs = 600000 } = {}) {
  const ids = (itemTypeIds || []).filter((id) => Number.isInteger(Number(id)));
  if (ids.length === 0) return [];
  const ins = await pool.query(
    `INSERT INTO world_items (world_id, item_type_id, x, y, expires_at, quantity)
     SELECT $1, t.item_type_id, $2, $3, now() + ($4::int * interval '1 millisecond'), 1
       FROM unnest($5::int[]) AS t(item_type_id)
     RETURNING id, item_type_id, x, y, expires_at, quantity`,
    [entry.worldId, x, y, ttlMs, ids.map(Number)],
  );
  entry.world.groundItems.add(ins.rows);
  return ins.rows;
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
// SOMET-96: how long a ground item is left alone after a claim threw. Auto-loot
// re-attempts every tick (20Hz) for as long as the item is in range and still
// in the sim, so a DB outage turned a bounded N-query batch into ~20N queries
// AND ~20N log lines per second, per looting player -- load amplified onto a
// database that is by definition already struggling. One second is long enough
// to stop the storm and short enough that a blip costs the player nothing they
// would notice.
const CLAIM_BACKOFF_MS = 1000;

// `now` is injectable so the backoff is testable without timers or sleeping.
async function claimItem(pool, entry, userId, characterId, groundItemId, { now = Date.now } = {}) {
  // Capacity is checked BEFORE the claim statement below, which DELETEs the
  // world_items row in the same breath as it grants: a post-hoc check would
  // have to put the item back on the ground. The item simply stays where it
  // is, and the CALLER decides what the player sees -- a toast for a
  // deliberate pickup, silence for the 20Hz auto-loot sweep.
  const holder = entry.world.getPlayer(userId);
  if (holder && holder.inv && !hasFreeSlot(holder.inv, entry.world.weapons)) {
    return { full: true };
  }
  // Lazily created so every existing hand-built `entry` fixture keeps working
  // -- there are many, in tests and in server.js's own world entries.
  if (!entry.claimRetryAt) entry.claimRetryAt = new Map();
  const retryAt = entry.claimRetryAt.get(groundItemId);
  if (retryAt != null) {
    if (now() < retryAt) return null;
    // Cooldown served: drop both marks and let this attempt through.
    entry.claimRetryAt.delete(groundItemId);
    entry.claiming.delete(groundItemId);
  }
  if (entry.claiming.has(groundItemId)) return null;
  entry.claiming.add(groundItemId);
  try {
    // SOMET-480: one statement still, and it now rebuilds the whole instance
    // -- the world row's deletion, the new player_items row AND its affix rows
    // commit or roll back together. A separate affix INSERT would reopen the
    // window claimItem's original CTE was written to close, in a nastier form:
    // an item granted with its rarity but silently stripped of its affixes.
    //
    // `aff` reads d.affixes with ORDINALITY and writes (ord - 1) into idx, so
    // the affix order dropItem snapshotted is the order that comes back. Its
    // RETURNING is then re-read by the outer projection (joined to affix_types
    // for `key` and `effect`) so the caller can hydrate the in-memory item
    // WITHOUT a second query -- see the push below for why a bare push would
    // make a just-picked-up affixed item inert until the next reconnect.
    //
    // `value` survives jsonb intact because both the column and the cast are
    // double precision: Postgres renders a float8 into jsonb with its
    // shortest round-tripping representation, so the number that went onto the
    // ground is the number that comes back. A `real` column would not have
    // that property (see the migration's note on the column type).
    const r = await pool.query(
      `WITH d AS (DELETE FROM world_items WHERE id = $1
                  RETURNING item_type_id, quantity, rarity, item_level, affixes, soulbound),
            ins AS (INSERT INTO player_items
                      (character_id, item_type_id, quantity, rarity, item_level, soulbound)
                    SELECT $2, item_type_id, quantity, rarity, item_level, soulbound FROM d
                    RETURNING id, item_type_id, quantity, rarity, item_level, soulbound),
            aff AS (INSERT INTO player_item_affixes (player_item_id, idx, affix_type_id, value)
                    SELECT ins.id, (a.ord - 1)::smallint,
                           (a.elem->>'affixTypeId')::int, (a.elem->>'value')::double precision
                      FROM ins, d, LATERAL jsonb_array_elements(d.affixes)
                                     WITH ORDINALITY AS a(elem, ord)
                    RETURNING idx, affix_type_id, value)
       SELECT ins.id, ins.item_type_id, ins.quantity, ins.rarity, ins.item_level, ins.soulbound,
              COALESCE((SELECT jsonb_agg(jsonb_build_object(
                                 'affixTypeId', aff.affix_type_id, 'key', at.key,
                                 'value', aff.value, 'effect', at.effect) ORDER BY aff.idx)
                          FROM aff JOIN affix_types at ON at.id = aff.affix_type_id),
                       '[]'::jsonb) AS affixes
         FROM ins`,
      [groundItemId, characterId],
    );
    if (r.rowCount !== 1) {
      entry.world.groundItems.remove(groundItemId); // stale row, evict
      // Released explicitly. This used to ride a `finally`, which the backoff
      // replaced -- a success or a lost race must still clear the mark, and
      // only a THROWN failure keeps it (with a deadline). Without this the id
      // would stay marked for the life of the world entry.
      entry.claiming.delete(groundItemId);
      return null;
    }
    const {
      id: instanceId, item_type_id: typeId, quantity,
      rarity, item_level: itemLevel, soulbound, affixes,
    } = r.rows[0];
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
    // SOMET-480: the in-memory copy carries the rolled identity too, INCLUDING
    // the affix list with its `effect` payloads. The statement above returns it
    // from the very INSERT that wrote the rows, so this costs no extra query.
    //
    // Populating it here is not cosmetic. equipRequirements#gearStatGrants
    // reads THIS object, not the database, so an entry pushed without its
    // affixes would make a just-picked-up item grant nothing until the next
    // loadInventory (a reconnect) -- a feature that is live in the schema and
    // inert in play, which is exactly the failure D1, D2 and C2 each shipped.
    // Defaults are supplied for callers with partial rows (the scripted pools
    // in authorityLoot.test.js), never as a production branch.
    if (p && p.inv) {
      p.inv.items.push({
        id: instanceId,
        typeId,
        quantity: qty,
        rarity: rarity || 'white',
        itemLevel: Number(itemLevel ?? 1),
        soulbound: soulbound === true,
        affixes: Array.isArray(affixes) ? affixes : [],
      });
    }
    entry.claiming.delete(groundItemId);
    return { id: instanceId, typeId, quantity: qty };
  } catch (err) {
    // Deliberately NOT released here. Leaving the id marked, with a deadline,
    // is the whole backoff: the guard above refuses every further attempt
    // until it expires, so one failure costs one query per second instead of
    // twenty. The error still propagates -- callers (server.js's pickup
    // handler, the auto-loot sweep) decide what the player sees.
    entry.claimRetryAt.set(groundItemId, now() + CLAIM_BACKOFF_MS);
    throw err;
  }
}

// Gold pickup: the currency path parallel to claimItem. One statement DELETEs
// the world_items row and credits users.gold, so there is no window where the
// row is gone but the wallet hasn't moved. rowCount === 1 means THIS call both
// removed the row and credited it; 0 means it lost the race (already claimed or
// swept) and nothing was credited. Returns the NEW balance so the caller can
// push a wallet update to the owner.
//
// SOMET-155: carries the SAME CLAIM_BACKOFF_MS discipline as claimItem, and
// shares its `entry.claimRetryAt` map (ground-item ids are unique across both
// paths — one id is either a coin pile or an item, never both). This used to be
// a bare try/finally that always released `claiming`, so the backoff SOMET-96
// added never applied to the currency path at all: a player standing on a coin
// pile with auto-loot on while the DB is unreachable re-issued claimGold on
// every 20Hz tick — ~20 failing queries and ~20 `auto-loot failed:` lines per
// second, per player, aimed at a database already in trouble. `now` is
// injectable for the same reason it is on claimItem: the backoff is testable
// without timers.
async function claimGold(pool, entry, userId, groundItemId, { now = Date.now } = {}) {
  // Lazily created, exactly as in claimItem — hand-built `entry` fixtures
  // (tests, and server.js's own world entries) predate the map.
  if (!entry.claimRetryAt) entry.claimRetryAt = new Map();
  const retryAt = entry.claimRetryAt.get(groundItemId);
  if (retryAt != null) {
    if (now() < retryAt) return null;
    // Cooldown served: drop both marks and let this attempt through.
    entry.claimRetryAt.delete(groundItemId);
    entry.claiming.delete(groundItemId);
  }
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
    // Released explicitly, mirroring claimItem: the `finally` this replaced
    // released the mark on EVERY exit including a thrown one, which is what
    // defeated the backoff. A success or a lost race must still clear it; only
    // a thrown failure keeps it, with a deadline.
    entry.claiming.delete(groundItemId);
    if (r.rowCount !== 1) return null;
    const gold = Number(r.rows[0].gold) || 0;
    const p = entry.world.getPlayer(userId);
    if (p) p.gold = gold;
    return { gold };
  } catch (err) {
    // Deliberately NOT released here — leaving the id marked, with a deadline,
    // IS the backoff: the guard above refuses every further attempt until it
    // expires, so one failure costs one query per second instead of twenty. The
    // error still propagates; callers decide what the player sees.
    entry.claimRetryAt.set(groundItemId, now() + CLAIM_BACKOFF_MS);
    throw err;
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

  // Guard (Critical #1, SOMET-245 final review): stone_instances.player_item_id
  // is ON DELETE CASCADE, and nothing on any acquisition path (claimItem,
  // buyStock) ever recreates a stone_instances row -- the conversion
  // migration (Task 2) is the only writer in the whole branch. Dropping a
  // stone (socketed or loose in the backpack) would therefore permanently
  // destroy its stone_instances row -- xp/level gone, and a re-acquired copy
  // of the same physical item can never be socketed again (socketStone joins
  // player_items to stone_instances and would report 'stone not found'
  // forever). A stone must leave a socket via unsocketStone, which correctly
  // deletes-or-preserves its row; refuse the drop instead of silently
  // destroying state a normal pickup can never restore. Mirrors the
  // 'unequip it first' guard shape immediately above.
  //
  // Joined against player_items on character_id, the same ownership
  // predicate the DELETE below uses -- NOT a bare stone_instances lookup by
  // itemId alone. Without the join, a caller could pass an itemId they do
  // not own at all and learn whether it happens to be a stone (a distinct
  // 'unsocket it first' vs. the generic 'you do not own that item' the
  // ownership check further down would otherwise give) -- a small
  // information leak about another player's inventory. Scoped, an unowned
  // id (stone or not) always falls through to that same generic rejection.
  const stoneCheck = await pool.query(
    `SELECT 1 FROM stone_instances si
       JOIN player_items pi ON pi.id = si.player_item_id
      WHERE si.player_item_id = $1 AND pi.character_id = $2`,
    [itemId, characterId],
  );
  if (stoneCheck.rowCount > 0) {
    return { ok: false, reason: 'unsocket it first' };
  }

  // SOMET-277 / SOMET-480: soulbound instances USED to be refused here. The
  // refusal existed for exactly one reason, stated verbatim in the original
  // comment: "world_items carries no soulbound column ... claimItem then
  // INSERTs a BRAND NEW player_items row which takes the column default
  // (false), so drop-then-pick-it-back-up would launder a bound item in two
  // keystrokes". T12's migration (1714440507000) adds that column. The flag
  // now RIDES the drop and is restored on the claim, so the item stays bound
  // through the round trip and the drop no longer has to be refused.
  //
  // That is strictly better than the refusal, not merely equivalent: starting
  // gear becomes droppable again (a player who outgrows their granted vest can
  // put it down) without becoming sellable. The sell refusal in trade.js is
  // untouched and is still the whole of what `soulbound` means.
  //
  // Consumption was never blocked and still isn't: ammo.js decrements/deletes
  // player_items rows when a Ranger fires their granted arrows. soulbound
  // restricts MONETIZATION, not use.
  //
  // `a soulbound instance is now DROPPABLE and comes back still bound` in
  // affixes_db.test.js is the replacement for the old refusal's test -- it
  // pins the property that refusal was protecting, through the real
  // dropItem -> claimItem path, rather than pinning the refusal itself.
  //
  // The stone refusal above is NOT relaxed the same way: stone_instances
  // carries xp and level that world_items has no column for, and
  // unsocketStone remains the only sanctioned way to part a stone from its
  // host.

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
  // `eject` mirrors services/stoneEject.js's ejectSocketedStone, inlined as
  // its own writable CTE rather than a separate call: dropItem has no
  // checked-out transaction client (the delete+insert pair is already one
  // atomic pool.query statement, per the F-016 comment above), so a second,
  // separate ejectSocketedStone(pool, itemId) call would be a second
  // implicit transaction -- a crash between the two would reopen exactly the
  // dangling-socket window this exists to close. `FROM d` (not `WHERE EXISTS
  // (SELECT ... FROM d)`) deliberately avoids the "select ... from d" text
  // shape the test below pins for the INSERT's own projection -- and ties
  // the UPDATE to d the same way: 0 rows in d (forged/unowned itemId) means
  // the join has no partner, so 0 rows update; the deleted host's real id in
  // d makes it match plain equality on socketed_into_id. Postgres executes
  // every writable CTE in a WITH clause for its side effects even when, as
  // here, nothing downstream reads its output (verified directly against
  // Postgres, including this exact WITH-DELETE-then-INSERT shape, before
  // relying on it).
  //
  // SOMET-480: the statement now also carries the instance's ROLLED IDENTITY
  // -- rarity, item_level, its affixes and soulbound -- onto the ground row.
  // Without that, dropItem's DELETE + claimItem's fresh INSERT silently
  // converts a rolled foxy item into a plain white one, because the only
  // thing world_items used to carry was item_type_id.
  //
  // `snap` reads player_item_affixes for the row `d` is deleting. Every CTE in
  // one statement sees the SAME snapshot taken at statement start, so the
  // ON DELETE CASCADE that removes those affix rows does not race this read --
  // the rows are still visible to `snap` even though `d` has removed their
  // parent. That is a load-bearing Postgres guarantee, not an accident of
  // ordering, and affixes_db.test.js's round-trip test is what pins it.
  //
  // ORDER BY pia.idx inside the aggregate, not merely a stable-looking scan:
  // the affix ORDER is what claimItem reconstructs idx from, so an unordered
  // aggregate would reshuffle a player's affix indices on every drop.
  const r = await pool.query(
    `WITH d AS (DELETE FROM player_items WHERE id = $1 AND character_id = $2
                RETURNING id, item_type_id, quantity, rarity, item_level, soulbound),
          snap AS (SELECT d.id,
                          COALESCE(jsonb_agg(
                            jsonb_build_object('affixTypeId', pia.affix_type_id, 'value', pia.value)
                            ORDER BY pia.idx
                          ) FILTER (WHERE pia.player_item_id IS NOT NULL), '[]'::jsonb) AS affixes
                     FROM d LEFT JOIN player_item_affixes pia ON pia.player_item_id = d.id
                    GROUP BY d.id),
          eject AS (UPDATE stone_instances SET socketed_into_id = NULL FROM d WHERE stone_instances.socketed_into_id = $1)
     INSERT INTO world_items (world_id, item_type_id, x, y, expires_at, quantity,
                              rarity, item_level, affixes, soulbound)
     SELECT $3, d.item_type_id, $4, $5, now() + ($6::int * interval '1 millisecond'), d.quantity,
            d.rarity, d.item_level, snap.affixes, d.soulbound
       FROM d JOIN snap ON snap.id = d.id
     RETURNING id, item_type_id, x, y, expires_at, quantity, rarity, item_level, affixes, soulbound`,
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
  rollDrops, rollGold, commitCreatureDeath, spawnDrops, spawnGroundItemTypes, claimItem, claimGold, dropItem, dropGraceActive, DROP_GRACE_MS,
};
