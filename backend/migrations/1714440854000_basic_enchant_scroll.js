exports.shorthands = undefined;

// The cheap enchant scroll: it only enchants inside the safe zone (+1..+3), so it costs a
// fraction of the standard scroll. Everything else about it (stackable consumable, on every
// village shelf) mirrors 'enchant_scroll'. The price mirrors DEFAULT_ENCHANT_CONFIG
// .basicScrollPrice in services/enchant.js; a migration is history, so it carries its own copy.

const NAME = 'enchant_scroll_basic';
const PRICE = 300;

exports.up = (pgm) => {
  pgm.sql(
    `INSERT INTO item_types (name, category, damage, cooldown, stackable, value)
     VALUES ('${NAME}', 'consumable', 0, 0, true, ${PRICE})
     ON CONFLICT (name) DO NOTHING`,
  );
  pgm.sql(
    `INSERT INTO merchant_stock (world_id, village_id, item_type_id, price, seller_user_id, expires_at, quantity)
     SELECT v.world_id, v.id, it.id, it.value, NULL, NULL, 1
       FROM villages v
       JOIN item_types it ON it.name = '${NAME}'
      WHERE NOT EXISTS (
        SELECT 1 FROM merchant_stock ms
         WHERE ms.village_id = v.id AND ms.item_type_id = it.id AND ms.seller_user_id IS NULL
      )`,
  );
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM merchant_stock WHERE item_type_id IN (SELECT id FROM item_types WHERE name = '${NAME}')`);
  pgm.sql(`DELETE FROM item_types WHERE name = '${NAME}'`);
};
