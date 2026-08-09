// Chest loot rolling and XP. Deliberately thin: chest_loot rows feed
// straight into loot.js's existing rollDrops so a chest and a creature kill
// share ONE rolling algorithm, and xpForChest reuses xpForKill unchanged —
// a chest's guard already has a level on the same scale a kill's creature
// does, so this is the existing formula applied to the guard's level rather
// than a new one.
const { rollDrops } = require('./loot.js');
const { xpForKill } = require('../services/playerStats.js');

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

module.exports = { rollChestLoot, xpForChest };
