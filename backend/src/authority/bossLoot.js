// backend/src/authority/bossLoot.js
// SOMET-611 (S10, spec §3.7). Boss loot: tier defaults + per-boss overrides,
// a biased-and-floored rarity roll, and the shared item/chest spawn helpers
// both the dungeon-boss death path (dungeonBosses.js, via server.js's
// onDungeonBossKilled) and the world-boss death path (worldBoss.js) call.
//
// Deliberately thin on rolling: `rollDrops`/`rollRarity`/`rollItemInstance`
// (loot.js, rarity.js, affixes.js) are reused unchanged, exactly as the spec
// asks -- "the boss profile only supplies count, floor and bias". This file
// owns resolving what those three values ARE (tier default, overridden by
// the entity's own loot_* columns when set) and the biased/floored wrapper
// around rollRarity, not a parallel rolling algorithm.
const { rollDrops, rollGold } = require('./loot.js');
const { rollRarity, RARITIES } = require('./rarity.js');
const { rollItemInstance } = require('./affixes.js');
const { mapChestRow } = require('../services/chests.js');

// Spec §3.7's table, verbatim. `rolls` for 'world' is "3 per damaging
// participant" -- a PER-RECIPIENT count, not a per-death total -- so the
// caller (worldBoss.js) multiplies this by its own contributor loop rather
// than this module knowing anything about participants.
// Hard ceiling on extra rolls per recipient -- matches the migration's CHECK
// and the admin validators. Each roll is a synchronous rollItemInstance on
// the authority loop plus a world_items row (per participant, for a world
// boss), so this is a stall guard, not a balance knob.
const MAX_LOOT_ROLLS = 20;

// A boss-death chest is transient: purged by the item sweep
// (purgeExpiredChests) BOSS_CHEST_TTL_MS after it spawns if nobody opens it,
// or BOSS_CHEST_OPENED_TTL_MS after it is opened -- the same 10 min / 30 s
// the world-boss victory chest always intended, now a DB deadline instead of
// an in-memory timer so it survives a restart or world reload.
const BOSS_CHEST_TTL_MS = 10 * 60 * 1000;
const BOSS_CHEST_OPENED_TTL_MS = 30 * 1000;

const TIER_LOOT_DEFAULTS = Object.freeze({
  dungeon_elite: Object.freeze({
    rolls: 2, minRarity: 'blue', bias: 0.2, chest: false,
  }),
  dungeon_end: Object.freeze({
    rolls: 4, minRarity: 'yellow', bias: 0.4, chest: true,
  }),
  world: Object.freeze({
    rolls: 3, minRarity: 'yellow', bias: 0.5, chest: true,
  }),
});

// NULL on any of the four entity_types columns means "use the tier
// default" -- `??` rather than `||` so an explicit 0 (loot_rolls: 0, "this
// boss drops no extra gear") or `false` (loot_chest: false, "no chest for
// this one") is honored rather than silently falling back to the tier's
// value. Returns null for a non-boss row (no boss_tier, or a tier this
// table has no entry for), so a caller can treat "no profile" as "run the
// ordinary, non-boss loot path" without a separate boss_tier check of its
// own.
function resolveLootProfile(entityTypeRow) {
  const tier = entityTypeRow && entityTypeRow.boss_tier;
  const defaults = TIER_LOOT_DEFAULTS[tier];
  if (!defaults) return null;
  const rolls = entityTypeRow.loot_rolls;
  const minRarity = entityTypeRow.loot_min_rarity;
  const bias = entityTypeRow.loot_rarity_bias;
  const chest = entityTypeRow.loot_chest;
  return {
    tier,
    rolls: rolls == null
      ? defaults.rolls
      : Math.min(MAX_LOOT_ROLLS, Math.max(0, Math.round(Number(rolls)) || 0)),
    minRarity: minRarity == null ? defaults.minRarity : minRarity,
    // `numeric` rides over the wire as a string; Number() it before the
    // clamp below runs, or a bias of "0.5" would compare as a string and
    // clamp wrong.
    bias: bias == null ? defaults.bias : Math.max(0, Math.min(0.9, Number(bias))),
    chest: chest == null ? defaults.chest : chest === true,
  };
}

// Maps rng()'s [0, 1) into [bias, 1) before handing it to rollRarity's own
// cumulative-weight walk. rollRarity is monotonic in its rng argument (a
// higher raw roll never yields a lower grade -- the cumulative walk only
// ever advances forward through RARITIES as its running total crosses the
// roll); composing it with this strictly-increasing affine map preserves
// that monotonicity, so "higher bias (or higher raw rng) never produces a
// worse rarity" holds for the SAME reason the unbiased roll already does,
// not as a separate property this file has to re-prove. bias is clamped to
// [0, 0.9] by resolveLootProfile before it ever reaches here, so this never
// degenerates to a constant (bias >= 1) or a no-op in the wrong direction
// (bias < 0).
function biasedRng(rng, bias) {
  return () => bias + (1 - bias) * rng();
}

// RARITIES is ascending (white < blue < yellow < foxy, rarity.js); raising a
// roll to `minRarity` is just "never return an index below the floor's".
function floorRarity(rarity, minRarity) {
  if (!minRarity) return rarity;
  const rolledIdx = RARITIES.indexOf(rarity);
  const floorIdx = RARITIES.indexOf(minRarity);
  if (floorIdx < 0) return rarity; // an unknown floor name is ignored, not thrown
  return rolledIdx < floorIdx ? minRarity : rarity;
}

// The single rarity roll every boss-death item (both the entity's own
// creature_drops/behavior_drops rows and the extra loot_rolls items) goes
// through -- biased, then floored. `anchors` null (no rarity_weights
// configured, or the tuning refresh failed) consumes NO rng, mirroring
// spawnDrops/openChest's own "no anchors -> white, no roll" contract -- but
// the floor still applies: "never below loot_min_rarity" is the boss
// profile's promise, and it must hold regardless of the weight table.
function rollBossRarity(itemLevel, anchors, profile, rng) {
  if (!anchors) return floorRarity('white', profile.minRarity);
  const rolled = rollRarity(itemLevel, anchors, biasedRng(rng, profile.bias));
  return floorRarity(rolled, profile.minRarity);
}

// Candidate pool for a boss's EXTRA loot_rolls items -- high-tier gear, not
// tied to any specific creature_drops row. Same shape and the same synthetic-
// fixture exclusions as loot.js's existing 30%-chance wild-creature gear
// roll (spawnDrops), copied rather than imported: that block is a single
// probabilistic pick woven into spawnDrops' control flow, not a function
// this file can call into, and duplicating the query here is cheaper than
// extracting it across both call sites for one slice.
async function rollBossGearItemTypeIds(pool, count, itemLevel, rng) {
  if (count <= 0) return [];
  const gRes = await pool.query(
    `SELECT id FROM item_types
      WHERE category IN ('weapon', 'armor')
        AND tier IS NOT NULL
        AND req_level <= $1
        AND name NOT LIKE 'resp-%' AND name NOT LIKE 'noop-%' AND name NOT LIKE 'req-%'
        AND name NOT LIKE 'ok-%' AND name NOT LIKE 'dep-%' AND name NOT LIKE 'free-%'
        AND name NOT LIKE 'over-%' AND name NOT LIKE 'atcap-%' AND name NOT LIKE 'circ-%'
        AND name NOT LIKE 's496_%' AND name NOT LIKE 's484-%' AND name NOT LIKE 's498-%'
        AND name NOT LIKE 's500-%' AND name NOT LIKE 'test-%' AND name NOT LIKE '%-test-%'
        AND name NOT LIKE 'probe-%' AND name NOT LIKE 'zz-%'
      ORDER BY req_level DESC
      LIMIT 15`,
    [Math.min(150, Math.max(1, Math.round(Number(itemLevel)) || 1))],
  );
  const rows = gRes.rows || [];
  if (rows.length === 0) return [];
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push(rows[Math.floor(rng() * rows.length)].id);
  }
  return out;
}

// Rolls + inserts one boss death's worth of items: the entity's own
// creature_drops/behavior_drops rows (queried here, exactly as spawnDrops
// does for an ordinary kill) PLUS `profile.rolls` extra gear items -- every
// one of them through the SAME biased/floored rarity roll, since "heavier
// boss -> better drop" is a property of the whole kill, not just the bonus
// items. Returns the inserted world_items rows (same shape spawnDrops'
// caller gets), or [] when nothing was rolled.
//
// `entityTypeId` is a separate param from `profile` (not read off it) --
// resolveLootProfile's return carries no entity identity, and the drop-row
// queries need the id regardless of which tier/override produced the
// profile. `includeOwnDrops: false` skips the entity's own drop rows: a
// world boss calls this once per participant, and its own rows belong to the
// KILL (rolled once), not to every recipient.
async function spawnBossLootItems(pool, entry, {
  entityTypeId, behaviorId = null, profile, itemLevel, x, y, includeOwnDrops = true,
  rarityAnchors = (entry && entry.rarityAnchors) || null,
  affixPool = (entry && entry.affixPool) || [],
  rng = Math.random, ttlMs = 180000,
}) {
  const dr = includeOwnDrops && entityTypeId != null
    ? await pool.query(
      'SELECT item_type_id, chance, min_qty, max_qty FROM creature_drops WHERE entity_type_id = $1',
      [entityTypeId],
    )
    : { rows: [] };
  const br = includeOwnDrops && behaviorId != null
    ? await pool.query(
      'SELECT item_type_id, chance, min_qty, max_qty FROM behavior_drops WHERE behavior_id = $1',
      [behaviorId],
    )
    : { rows: [] };
  const ownDropIds = [...rollDrops(dr.rows, rng), ...rollDrops(br.rows, rng)];
  const extraIds = await rollBossGearItemTypeIds(pool, profile.rolls, itemLevel, rng);
  const allIds = [...ownDropIds, ...extraIds];
  if (allIds.length === 0) return [];

  const lvl = Math.min(150, Math.max(1, Math.round(Number(itemLevel)) || 1));
  const rarities = [];
  const itemLevels = [];
  const affixJson = [];
  for (const typeId of allIds) {
    const rarity = rollBossRarity(lvl, rarityAnchors, profile, rng);
    const itemType = entry.world && entry.world.weapons ? entry.world.weapons.get(typeId) : null;
    const rolled = rollItemInstance({
      itemType, itemLevel: lvl, rarity, affixPool,
    }, rng);
    rarities.push(rolled.rarity);
    itemLevels.push(rolled.itemLevel);
    affixJson.push(JSON.stringify(
      rolled.affixes.map((a) => ({ affixTypeId: a.affixTypeId, value: a.value })),
    ));
  }
  const ins = await pool.query(
    `INSERT INTO world_items (world_id, item_type_id, x, y, expires_at, quantity,
                              rarity, item_level, affixes)
     SELECT $1, t.item_type_id, $2, $3, now() + ($4::int * interval '1 millisecond'), 1,
            t.rarity, t.item_level, t.affixes
       FROM unnest($5::int[], $6::text[], $7::int[], $8::jsonb[])
              AS t(item_type_id, rarity, item_level, affixes)
     RETURNING id, item_type_id, x, y, expires_at, quantity, rarity, item_level`,
    [entry.worldId, Math.round(x), Math.round(y), ttlMs, allIds, rarities, itemLevels, affixJson],
  );
  entry.world.groundItems.add(ins.rows);
  return ins.rows;
}

// A boss's gold drop, separate from the item roll above because gold rides
// its own `world_items` row with no rarity/affixes (same split spawnDrops
// keeps). `goldRange` is the entity's own {min,max} (bossGoldRange, read off
// the catalog row's gold_min/gold_max, spec §3.1), falling back to a
// boss-generic range only when the row authors none -- a defeated boss
// dropping literally 0 gold would be a silent regression next to the
// ordinary-creature path this mirrors.
const DEFAULT_BOSS_GOLD_RANGE = Object.freeze({ min: 100, max: 600 });

function bossGoldRange(row) {
  const min = Number(row && row.gold_min);
  const max = Number(row && row.gold_max);
  if (!Number.isFinite(max) || max <= 0) return DEFAULT_BOSS_GOLD_RANGE;
  const lo = Number.isFinite(min) && min >= 0 ? Math.min(min, max) : 0;
  return { min: lo, max };
}

async function spawnBossGold(pool, entry, {
  x, y, goldRange = DEFAULT_BOSS_GOLD_RANGE, rng = Math.random, ttlMs = 180000,
}) {
  const amt = rollGold(goldRange, rng);
  if (amt <= 0 || entry.goldItemTypeId == null) return null;
  const gi = await pool.query(
    `INSERT INTO world_items (world_id, item_type_id, x, y, expires_at, quantity)
     VALUES ($1, $2, $3, $4, now() + ($5::int * interval '1 millisecond'), $6)
     RETURNING id, item_type_id, x, y, expires_at, quantity`,
    [entry.worldId, entry.goldItemTypeId, Math.round(x), Math.round(y), ttlMs, amt],
  );
  entry.world.groundItems.add(gi.rows);
  return gi.rows[0];
}

// Spawns a boss chest at the death point, already 'unlocked' (there is no
// live guard to kill -- the boss itself WAS the guard) -- same state
// openChest already treats as "CAS straight through to opened", per its own
// `if (chest.state === 'locked')` branch never running for an empty
// guard_creature_ids array. `guardEntityTypeId` is the DEFEATED BOSS's own
// id: world_chests.guard_entity_type_id is NOT NULL with no sentinel row to
// point at instead, and "the boss you just killed" is the only entity this
// chest has any relationship to -- the same role insertVaultChest's
// `guardCreatureType` plays for an authored vault chest's live guard,
// reused here for a chest with no live guard at all. Returns the chest in
// the same camelCase shape fetchChests/spawnFieldChest already produce
// (mapChestRow), so entry.chests stays one consistent shape regardless of
// which path pushed a row onto it.
//
// The chest is transient: expires_at = now() + ttlMs, purged by the item
// sweep (purgeExpiredChests); the openchest handler shortens it to
// BOSS_CHEST_OPENED_TTL_MS once opened. Without this, every boss respawn
// cycle stacked one more permanent row at the same spot.
async function spawnBossChest(pool, entry, {
  x, y, guardEntityTypeId, guardLevel, ttlMs = BOSS_CHEST_TTL_MS,
}) {
  const ins = await pool.query(
    `INSERT INTO world_chests (world_id, x, y, kind, guard_entity_type_id, guard_level, guard_creature_ids, state, expires_at)
     VALUES ($1, $2, $3, 'vault', $4, $5, '[]'::jsonb, 'unlocked', now() + ($6::int * interval '1 millisecond'))
     RETURNING id, x, y, kind, guard_entity_type_id, guard_level, guard_creature_ids, state, opened_at, respawn_at, expires_at`,
    [entry.worldId, Math.round(x), Math.round(y), guardEntityTypeId,
      Math.max(1, Math.round(Number(guardLevel)) || 1), Math.round(ttlMs)],
  );
  const chest = mapChestRow(ins.rows[0]);
  if (!entry.chests) entry.chests = [];
  entry.chests.push(chest);
  return chest;
}

// Called by the openchest handler once a transient boss chest is opened:
// pulls its purge deadline in to `ttlMs` from now (LEAST -- never later than
// it already was) and mirrors the new value onto the in-memory chest. A
// chest with no deadline (authored vault/field chest) is left untouched.
async function shortenBossChestExpiry(pool, chest, ttlMs = BOSS_CHEST_OPENED_TTL_MS) {
  if (!chest || chest.expiresAt == null) return chest;
  const r = await pool.query(
    `UPDATE world_chests
        SET expires_at = LEAST(expires_at, now() + ($2::int * interval '1 millisecond'))
      WHERE id = $1 AND expires_at IS NOT NULL
      RETURNING expires_at`,
    [chest.id, Math.round(ttlMs)],
  );
  if (r.rows[0]) chest.expiresAt = r.rows[0].expires_at;
  return chest;
}

// The dungeon-boss death handler: DungeonBossManager's `onKilled` hook
// (server.js wires this in as `opts.onDungeonBossKilled`'s default). `kill`
// is exactly the object dungeonBosses.js's onDeath builds -- entry, x/y
// already the death point's CENTRE, `row` the full catalog row (loot_*
// columns included via ENTITY_CATALOG_SELECT).
//
// A dungeon boss has no world_creatures row, so none of this goes through
// commitCreatureDeath -- it is a standalone award, same posture spawnDrops
// has for an ordinary kill but without the surrounding transaction (there is
// no DELETE to commit atomically WITH; a failed roll here costs the kill its
// loot, not its death, since the boss is already out of the sim by the time
// onDeath fires).
//
// XP is deliberately NOT awarded here -- out of this ticket's scope (SOMET-
// 611 is loot only; see the ticket's own acceptance criteria). A dungeon
// boss kill currently grants zero XP regardless of this function; that gap
// predates this slice and is not silently papered over by it.
async function awardDungeonBossLoot(kill, {
  pool, rng = Math.random, ttlMs = 180000,
  broadcastItemsFn = null, broadcastChestsFn = null,
} = {}) {
  const profile = resolveLootProfile(kill.row);
  if (!profile) return null; // not a tier this table knows (defensive; dungeonBosses.js only routes real boss rows here)
  const { entry } = kill;

  // Each step is independent: a failed gold insert must not cost the kill
  // its chest, and whatever DID land must still be broadcast (the items are
  // already in groundItems either way). Failures are collected and rethrown
  // after the broadcast so dungeonBosses.js's onKilled catch still logs them.
  const errors = [];
  let items = [];
  let chest = null;
  try {
    items = await spawnBossLootItems(pool, entry, {
      entityTypeId: kill.entityTypeId,
      behaviorId: kill.row.behavior_id ?? null,
      profile,
      itemLevel: kill.level,
      x: kill.x,
      y: kill.y,
      rng,
      ttlMs,
    });
  } catch (err) { errors.push(err); }
  try {
    await spawnBossGold(pool, entry, {
      x: kill.x, y: kill.y, goldRange: bossGoldRange(kill.row), rng, ttlMs,
    });
  } catch (err) { errors.push(err); }
  if (profile.chest && kill.entityTypeId != null) {
    try {
      chest = await spawnBossChest(pool, entry, {
        x: kill.x, y: kill.y, guardEntityTypeId: kill.entityTypeId, guardLevel: kill.level,
      });
    } catch (err) { errors.push(err); }
  }

  if (broadcastItemsFn) broadcastItemsFn(entry);
  if (chest && broadcastChestsFn) broadcastChestsFn(entry);

  if (errors.length) throw errors[0];
  return { items, chest };
}

module.exports = {
  MAX_LOOT_ROLLS,
  BOSS_CHEST_TTL_MS,
  BOSS_CHEST_OPENED_TTL_MS,
  DEFAULT_BOSS_GOLD_RANGE,
  bossGoldRange,
  TIER_LOOT_DEFAULTS,
  resolveLootProfile,
  biasedRng,
  floorRarity,
  rollBossRarity,
  rollBossGearItemTypeIds,
  spawnBossLootItems,
  spawnBossGold,
  spawnBossChest,
  shortenBossChestExpiry,
  awardDungeonBossLoot,
};
