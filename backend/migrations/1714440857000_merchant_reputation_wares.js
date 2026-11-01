/* eslint-disable camelcase */
// Premium wares unlocked by village reputation.
//
// merchant_stock.min_reputation: 0 = open to everyone (every existing row);
// above 0 = shown locked until the player's standing with THAT village reaches
// it (see services/reputation.js). The base catalogue only ever held tier-1
// gear; tiers 2-4 now sit behind Friend (30), Honored (100) and Revered (250).
// Only villages that have a spec_key get them: generated villages have no
// quests, so their standing can never rise.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE merchant_stock ADD COLUMN IF NOT EXISTS min_reputation integer NOT NULL DEFAULT 0`);
  pgm.sql(`
    INSERT INTO merchant_stock (world_id, village_id, item_type_id, price, seller_user_id, expires_at, quantity, min_reputation)
    SELECT v.world_id, v.id, it.id, it.value, NULL, NULL, 1,
           CASE it.tier WHEN 2 THEN 30 WHEN 3 THEN 100 ELSE 250 END
      FROM villages v
      JOIN item_types it ON it.category IN ('weapon','armor') AND it.value > 0 AND it.tier IN (2, 3, 4)
     WHERE v.spec_key IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM merchant_stock ms
          WHERE ms.village_id = v.id AND ms.item_type_id = it.id AND ms.seller_user_id IS NULL
       )
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM merchant_stock WHERE min_reputation > 0`);
  pgm.sql(`ALTER TABLE merchant_stock DROP COLUMN IF EXISTS min_reputation`);
};
