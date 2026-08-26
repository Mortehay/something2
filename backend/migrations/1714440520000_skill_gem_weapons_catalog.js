/* eslint-disable camelcase */
exports.shorthands = undefined;

// Adds the expanded weapon families (bow, crossbow, dagger, staff, scepter, axe, sword, mace, quarterstaff)
// to the item_types catalog across all 10 tiers and seeds them into merchant_stock across all villages.

const { generateGearLadder, upsertGearLadder } = require('../seeds/generateGearLadder.js');
const { GEAR_TIERS, GEAR_FAMILIES } = require('../seeds/data/gearLadder.js');

exports.up = async (pgm) => {
  const rows = generateGearLadder({ tiers: GEAR_TIERS, families: GEAR_FAMILIES });
  await upsertGearLadder(pgm.db, rows);

  // Seed all base catalog weapons & armor into every existing village's merchant_stock
  await pgm.db.query(
    `INSERT INTO merchant_stock (world_id, village_id, item_type_id, price, seller_user_id, expires_at, quantity)
     SELECT v.world_id, v.id, it.id, it.value, NULL, NULL, 1
       FROM villages v
       CROSS JOIN item_types it
      WHERE it.category IN ('weapon', 'armor') AND it.value > 0
        AND NOT EXISTS (
          SELECT 1 FROM merchant_stock ms
           WHERE ms.village_id = v.id AND ms.item_type_id = it.id AND ms.seller_user_id IS NULL
        )`,
  );
};

exports.down = async (pgm) => {
  // Safe rollback: delete unused ladder rows that no player owns or holds
  const rows = generateGearLadder({ tiers: GEAR_TIERS, families: GEAR_FAMILIES });
  await pgm.db.query(
    `DELETE FROM item_types it
      WHERE it.name = ANY($1::text[])
        AND NOT EXISTS (SELECT 1 FROM player_items pi WHERE pi.item_type_id = it.id)
        AND NOT EXISTS (SELECT 1 FROM account_items ai WHERE ai.item_type_id = it.id)`,
    [rows.map((r) => r.name)],
  );
};
