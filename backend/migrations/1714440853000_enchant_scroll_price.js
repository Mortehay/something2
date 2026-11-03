exports.shorthands = undefined;

// The enchant scroll costs 5x what it did (400 -> 2000 gold).
//
// The price lives in TWO places and a config edit moves neither of them: services/enchant.js
// (scrollPrice, what the blacksmith charges) and the database -- item_types.value (what
// seedBaseCatalog stamps on a new village's shelf, and what a merchant pays to buy one back)
// and the merchant_stock rows already on every existing village's shelf. This updates the
// database half. Buyback rows (seller_user_id set) are a player's own sale and are left alone.

const NEW_PRICE = 2000;
const OLD_PRICE = 400;

exports.up = (pgm) => {
  pgm.sql(`UPDATE item_types SET value = ${NEW_PRICE} WHERE name = 'enchant_scroll'`);
  pgm.sql(
    `UPDATE merchant_stock SET price = ${NEW_PRICE}
      WHERE seller_user_id IS NULL
        AND item_type_id IN (SELECT id FROM item_types WHERE name = 'enchant_scroll')`,
  );
};

exports.down = (pgm) => {
  pgm.sql(`UPDATE item_types SET value = ${OLD_PRICE} WHERE name = 'enchant_scroll'`);
  pgm.sql(
    `UPDATE merchant_stock SET price = ${OLD_PRICE}
      WHERE seller_user_id IS NULL
        AND item_type_id IN (SELECT id FROM item_types WHERE name = 'enchant_scroll')`,
  );
};
