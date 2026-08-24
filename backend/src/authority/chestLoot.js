// Chest loot rolling and XP. Deliberately thin: chest_loot rows feed
// straight into loot.js's existing rollDrops so a chest and a creature kill
// share ONE rolling algorithm, and xpForChest reuses xpForKill unchanged —
// a chest's guard already has a level on the same scale a kill's creature
// does, so this is the existing formula applied to the guard's level rather
// than a new one.
const { rollDrops } = require('./loot.js');
const { rollRarity } = require('./rarity.js');
const { rollItemInstance } = require('./affixes.js');
const { xpForKill } = require('../services/playerStats.js');
const { awardXp, loadProgression } = require('../services/progressionStore.js');

// Field chests relock and get a fresh guard this long after being opened;
// vault chests never carry a respawn_at at all (see openChest below). Also
// consumed by chests.js's respawnDueFieldChests indirectly, via the
// respawn_at column this constant sizes -- exported so a test (or a future
// caller) can reference the exact duration rather than re-deriving it.
const FIELD_CHEST_RESPAWN_MS = 2 * 60 * 60 * 1000;

async function rollChestLoot(pool, guardLevel, rng = Math.random) {
  const r = await pool.query(
    'SELECT item_type_id, chance, min_qty, max_qty FROM chest_loot WHERE level_min <= $1 AND level_max >= $1',
    [guardLevel],
  );
  return rollDrops(r.rows, rng);
}

function xpForChest(guardLevel, playerLevel) {
  return xpForKill(guardLevel, playerLevel);
}

// The single authoritative chest-open. The state CAS (locked/unlocked ->
// 'opened' via an UPDATE ... WHERE state='unlocked' RETURNING id) plays the
// same role commitCreatureDeath's DELETE...RETURNING plays for a kill: only
// the request whose UPDATE actually affects a row licenses the loot roll
// and XP award, so two concurrent opens of the same chest cannot
// double-grant. Everything runs inside one transaction, same posture as
// commitCreatureDeath.
// `characterId`, not a user id (SOMET-257/260 merge). player_items,
// player_progression and awardXp are all keyed by CHARACTER now; this function
// was written on a parallel branch against the account-keyed schema, and the
// merge of the two lines is textually clean but semantically wrong -- the
// INSERT below referenced a player_items.user_id column that no longer exists,
// so opening a chest threw at runtime rather than granting anything.
// `freeSlots` is how many player_items rows this character can still take. It
// defaults to Infinity so every existing caller and fixture behaves exactly as
// before; server.js passes the real number.
// SOMET-481: `rarityAnchors`, `affixPool` and `itemTypes` all default to "no
// rolling" / "no catalog", so every existing caller and fixture keeps granting
// plain white items exactly as before. server.js supplies the live values off
// the world entry.
async function openChest(pool, chestId, characterId, {
  rng = Math.random, freeSlots = Infinity,
  rarityAnchors = null, affixPool = [], itemTypes = null,
} = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cr = await client.query(
      'SELECT id, state, kind, guard_creature_ids, guard_level FROM world_chests WHERE id = $1 FOR UPDATE',
      [chestId],
    );
    if (cr.rowCount === 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'chest not found' };
    }
    const chest = cr.rows[0];
    if (chest.state === 'opened') {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'already opened' };
    }
    if (chest.state === 'locked') {
      // guard_creature_ids is a jsonb column: pg already hands this back as
      // a parsed JS array, so there is nothing to JSON.parse here.
      const guardIds = chest.guard_creature_ids;
      if (guardIds.length > 0) {
        const alive = await client.query(
          'SELECT count(*) AS count FROM world_creatures WHERE id = ANY($1::uuid[])', [guardIds],
        );
        // count(*) is bigint, which pg returns as a string -- Number() it
        // rather than relying on JS's string/number > coercion.
        if (Number(alive.rows[0].count) > 0) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'guard is still alive' };
        }
      }
      await client.query("UPDATE world_chests SET state = 'unlocked' WHERE id = $1", [chestId]);
    }

    const cas = await client.query(
      "UPDATE world_chests SET state = 'opened', opened_at = now() WHERE id = $1 AND state = 'unlocked' RETURNING id, opened_at",
      [chestId],
    );
    if (cas.rowCount !== 1) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'already opened' };
    }
    const openedAt = cas.rows[0].opened_at;

    // Field chests get a respawn timer; vault chests never do (queried once
    // more here via `RETURNING respawn_at` -- rather than computed in JS from
    // FIELD_CHEST_RESPAWN_MS/Date.now() -- so the value handed back to the
    // caller for the in-memory entry.chests sync is the exact DB-assigned
    // timestamp, not a value that could drift from it under clock skew).
    let respawnAt = null;
    if (chest.kind === 'field') {
      const rr = await client.query(
        'UPDATE world_chests SET respawn_at = now() + ($1::int * interval \'1 millisecond\') WHERE id = $2 RETURNING respawn_at',
        [FIELD_CHEST_RESPAWN_MS, chestId],
      );
      respawnAt = rr.rows[0]?.respawn_at ?? null;
    }

    const itemTypeIds = await rollChestLoot(client, chest.guard_level, rng);
    const items = [];
    // The chest has already been CAS'd open above and can never be re-opened,
    // so refusing here would DESTROY the loot. Grant what fits and hand the
    // rest back to the caller to spawn on the ground: the player keeps
    // everything they rolled, and a full inventory costs them a walk instead
    // of the reward.
    const overflowTypeIds = [];
    // Built ONCE, not per granted item: affix_types rows carry the `effect`
    // payload the in-memory copy below needs, and rollItemInstance's return
    // shape does not.
    const affixById = new Map((affixPool || []).filter((a) => a).map((a) => [a.id, a]));
    for (const itemTypeId of itemTypeIds) {
      if (items.length >= freeSlots) { overflowTypeIds.push(itemTypeId); continue; }
      // One row per unit (rollChestLoot/rollDrops already repeats
      // itemTypeId per unit rolled), same one-row-per-unit shape
      // claimItem/spawnDrops use elsewhere in loot.js. `items` reports the
      // FULL inserted row ({id, item_type_id, quantity}, matching
      // claimItem's own shape at loot.js:232) rather than a bare
      // item_type_id -- the caller (server.js's `openchest` handler) needs
      // the id/quantity to push each grant onto p.inv.items the same way
      // claimItem does ("so a later equip validates without a reload"). A
      // bare item_type_id list gave the handler nothing to push, so a
      // chest-granted item could not be equipped/dropped/sold until the
      // player reconnected and reloaded their inventory from the DB.
      //
      // SOMET-481: a chest's item level is its GUARD's level -- the same scale
      // a kill's creature level is on, which is why xpForChest already reuses
      // xpForKill. Clamped to player_items_item_level_check's 1..150 window so
      // an out-of-band guard_level cannot make the grant throw and cost the
      // player loot the chest has already been CAS'd open to give them.
      const itemLevel = Math.min(150, Math.max(1, Math.round(Number(chest.guard_level)) || 1));
      const rarity = rarityAnchors ? rollRarity(itemLevel, rarityAnchors, rng) : 'white';
      const rolled = rollItemInstance(
        {
          itemType: itemTypes ? itemTypes.get(itemTypeId) : null,
          itemLevel,
          rarity,
          affixPool,
        },
        rng,
      );
      const ins = await client.query(
        `INSERT INTO player_items (character_id, item_type_id, quantity, rarity, item_level)
         VALUES ($1,$2,1,$3,$4) RETURNING id, item_type_id, quantity, rarity, item_level`,
        [characterId, itemTypeId, rolled.rarity, rolled.itemLevel],
      );
      // Inside the SAME transaction as the grant: an item handed over with its
      // rarity but silently stripped of its affixes is the failure claimItem's
      // single-statement CTE exists to prevent, and a chest grant must not
      // reintroduce it through a second, separately-committed write.
      for (let i = 0; i < rolled.affixes.length; i += 1) {
        await client.query(
          `INSERT INTO player_item_affixes (player_item_id, idx, affix_type_id, value)
           VALUES ($1,$2,$3,$4)`,
          [ins.rows[0].id, i, rolled.affixes[i].affixTypeId, rolled.affixes[i].value],
        );
      }
      // The caller pushes this onto p.inv.items so a chest-granted item is
      // equippable without a reconnect (see the comment above). It therefore
      // has to carry the rolled affixes too, and specifically each affix's
      // `effect`: equipRequirements#gearStatGrants reads a.effect.type/.stat
      // and SILENTLY SKIPS an affix that has none, so a list pushed without it
      // is a stat bonus that exists in the database and does nothing in play
      // until the next reconnect -- the exact "live in the schema, inert in
      // play" shape D1, D2 and C2 each shipped. rollItemInstance returns
      // {affixTypeId, key, value}; the effect comes from the pool row that was
      // rolled, so this costs no query.
      items.push({
        ...ins.rows[0],
        affixes: rolled.affixes.map((a) => ({
          affixTypeId: a.affixTypeId,
          key: a.key,
          value: a.value,
          effect: (affixById.get(a.affixTypeId) || {}).effect ?? null,
          // SOMET-496: same reason `effect` rides along. gearAffixes.js
          // captions each gear modifier with this, and a just-opened chest
          // must not label an affix differently from the way the same item
          // reads after a reconnect (loadInventory selects at.label).
          label: (affixById.get(a.affixTypeId) || {}).label ?? null,
        })),
      });
    }

    const before = await loadProgression(client, characterId);
    const amount = xpForChest(chest.guard_level, before.level);
    const award = await awardXp(client, characterId, amount, 'chest');

    await client.query('COMMIT');
    return {
      ok: true,
      items,
      overflowTypeIds,
      awarded: award.awarded,
      leveledUp: award.leveledUp,
      newLevel: award.newLevel,
      // awardXp always computes this (even on a no-op award), and the
      // `openchest` handler needs it to call world.applyDerivedStats on a
      // level-up -- the exact call the kill path makes (server.js:426-463)
      // and the exact thing the kill path's own comment calls out as "the
      // exact defect A1's review caught" when omitted: a player's max HP
      // rises in the DB but the running game never reflects it until
      // reconnect.
      progression: award.progression,
      // Handed back so the caller (server.js's `openchest` handler) can carry
      // these onto the in-memory entry.chests element alongside `state`,
      // not just persist them to the DB row -- otherwise a respawned field
      // chest's marker/state would look stale to already-connected players
      // (entry.chests wouldn't show a respawn_at at all until a full reload).
      openedAt,
      respawnAt,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  rollChestLoot, xpForChest, openChest, FIELD_CHEST_RESPAWN_MS,
};
