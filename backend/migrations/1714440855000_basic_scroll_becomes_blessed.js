exports.shorthands = undefined;

// The cheap "basic" scroll (1714440854000) is replaced by a BLESSED scroll: the same catalog row,
// renamed and re-priced, so every shelf row, inventory stack and ground item that held it follows
// automatically. Its rules changed with the name: it now works only PAST the safe zone and, when it
// misses, drops the weapon back to +3 instead of burning it (services/enchant.js).
//
// The price mirrors DEFAULT_ENCHANT_CONFIG.blessedScrollPrice; a migration is history, so it carries
// its own copy.

const OLD = 'enchant_scroll_basic';
const NEW = 'enchant_scroll_blessed';
const PRICE = 6000;
const OLD_PRICE = 300;

exports.up = (pgm) => {
  pgm.sql(`UPDATE item_types SET name = '${NEW}', value = ${PRICE} WHERE name = '${OLD}'`);
  // A database that never ran the 'basic' migration (it was never released) still gets the item.
  pgm.sql(
    `INSERT INTO item_types (name, category, damage, cooldown, stackable, value)
     VALUES ('${NEW}', 'consumable', 0, 0, true, ${PRICE})
     ON CONFLICT (name) DO NOTHING`,
  );
  pgm.sql(
    `UPDATE merchant_stock SET price = ${PRICE}
      WHERE seller_user_id IS NULL
        AND item_type_id IN (SELECT id FROM item_types WHERE name = '${NEW}')`,
  );
  pgm.sql(
    `INSERT INTO merchant_stock (world_id, village_id, item_type_id, price, seller_user_id, expires_at, quantity)
     SELECT v.world_id, v.id, it.id, it.value, NULL, NULL, 1
       FROM villages v
       JOIN item_types it ON it.name = '${NEW}'
      WHERE NOT EXISTS (
        SELECT 1 FROM merchant_stock ms
         WHERE ms.village_id = v.id AND ms.item_type_id = it.id AND ms.seller_user_id IS NULL
      )`,
  );
};

exports.down = (pgm) => {
  pgm.sql(`UPDATE item_types SET name = '${OLD}', value = ${OLD_PRICE} WHERE name = '${NEW}'`);
  pgm.sql(
    `UPDATE merchant_stock SET price = ${OLD_PRICE}
      WHERE seller_user_id IS NULL
        AND item_type_id IN (SELECT id FROM item_types WHERE name = '${OLD}')`,
  );
};
