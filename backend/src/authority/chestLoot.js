// Chest loot rolling and XP. Deliberately thin: chest_loot rows feed
// straight into loot.js's existing rollDrops so a chest and a creature kill
// share ONE rolling algorithm, and xpForChest reuses xpForKill unchanged —
// a chest's guard already has a level on the same scale a kill's creature
// does, so this is the existing formula applied to the guard's level rather
// than a new one.
const { rollDrops } = require('./loot.js');
const { xpForKill } = require('../services/playerStats.js');
const { awardXp, loadProgression } = require('../services/progressionStore.js');

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
async function openChest(pool, chestId, userId, { rng = Math.random } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cr = await client.query(
      'SELECT id, state, guard_creature_ids, guard_level FROM world_chests WHERE id = $1 FOR UPDATE',
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
      "UPDATE world_chests SET state = 'opened', opened_at = now() WHERE id = $1 AND state = 'unlocked' RETURNING id",
      [chestId],
    );
    if (cas.rowCount !== 1) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'already opened' };
    }

    const itemTypeIds = await rollChestLoot(client, chest.guard_level, rng);
    const items = [];
    for (const itemTypeId of itemTypeIds) {
      // One row per unit (rollChestLoot/rollDrops already repeats
      // itemTypeId per unit rolled), same one-row-per-unit shape
      // claimItem/spawnDrops use elsewhere in loot.js. `items` reports the
      // bare item_type_id list, not the inserted row objects.
      await client.query(
        `INSERT INTO player_items (user_id, item_type_id, quantity)
         VALUES ($1,$2,1) RETURNING id, item_type_id, quantity`,
        [userId, itemTypeId],
      );
      items.push(itemTypeId);
    }

    const before = await loadProgression(client, userId);
    const amount = xpForChest(chest.guard_level, before.level);
    const award = await awardXp(client, userId, amount, 'chest');

    await client.query('COMMIT');
    return {
      ok: true, items, awarded: award.awarded, leveledUp: award.leveledUp, newLevel: award.newLevel,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { rollChestLoot, xpForChest, openChest };
