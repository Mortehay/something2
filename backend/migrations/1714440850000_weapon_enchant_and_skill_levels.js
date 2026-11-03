exports.shorthands = undefined;

// Weapon enchanting and paid skill levels.
//
//  1. player_items.enchant_level  -- how many scrolls a weapon has taken (+0..+15).
//     world_items.enchant_level   -- the same fact while the weapon lies on the ground,
//     so dropping and picking up an enchanted weapon does not strip it (dropItem and
//     claimItem copy it across; nothing else moves an instance between those tables).
//  2. The `enchant_scroll` item: a stackable `consumable` (the category loot_map
//     already uses) that merchants sell. Its price is a column value; the odds and the
//     damage per level live in services/enchant.js.
//  3. character_skill_levels      -- a character's purchased level in each skill (1..15;
//     a skill with no row is level 0).

const MAX_ENCHANT = 15;
const MAX_SKILL_LEVEL = 15;
const SCROLL_NAME = 'enchant_scroll';
// Mirrors DEFAULT_ENCHANT_CONFIG.scrollPrice in services/enchant.js. A migration is
// history, so it carries its own copy instead of importing a value that may change.
const SCROLL_PRICE = 400;

exports.up = (pgm) => {
  for (const table of ['player_items', 'world_items']) {
    pgm.addColumns(table, {
      enchant_level: { type: 'smallint', notNull: true, default: 0 },
    });
    pgm.addConstraint(table, `${table}_enchant_level_check`,
      `CHECK (enchant_level BETWEEN 0 AND ${MAX_ENCHANT})`);
  }

  pgm.sql(
    `INSERT INTO item_types (name, category, damage, cooldown, stackable, value)
     VALUES ('${SCROLL_NAME}', 'consumable', 0, 0, true, ${SCROLL_PRICE})
     ON CONFLICT (name) DO NOTHING`,
  );
  // Put the scroll on every existing village's shelf. New villages get it from
  // seedBaseCatalog (services/merchantStock.js), which now includes it.
  pgm.sql(
    `INSERT INTO merchant_stock (world_id, village_id, item_type_id, price, seller_user_id, expires_at, quantity)
     SELECT v.world_id, v.id, it.id, it.value, NULL, NULL, 1
       FROM villages v
       JOIN item_types it ON it.name = '${SCROLL_NAME}'
      WHERE NOT EXISTS (
        SELECT 1 FROM merchant_stock ms
         WHERE ms.village_id = v.id AND ms.item_type_id = it.id AND ms.seller_user_id IS NULL
      )`,
  );

  pgm.createTable('character_skill_levels', {
    character_id: { type: 'integer', notNull: true, references: 'characters', onDelete: 'CASCADE' },
    skill_id: { type: 'text', notNull: true },
    level: { type: 'smallint', notNull: true },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  }, {
    constraints: { primaryKey: ['character_id', 'skill_id'] },
  });
  pgm.addConstraint('character_skill_levels', 'character_skill_levels_level_check',
    `CHECK (level BETWEEN 1 AND ${MAX_SKILL_LEVEL})`);
};

exports.down = (pgm) => {
  pgm.dropTable('character_skill_levels');
  pgm.sql(
    `DELETE FROM merchant_stock WHERE item_type_id IN (SELECT id FROM item_types WHERE name = '${SCROLL_NAME}')`,
  );
  // Scrolls already in inventories go with their catalog row (player_items.item_type_id
  // cascades), which is the honest rollback: nothing can use them any more.
  pgm.sql(`DELETE FROM item_types WHERE name = '${SCROLL_NAME}'`);
  for (const table of ['world_items', 'player_items']) {
    pgm.dropConstraint(table, `${table}_enchant_level_check`);
    pgm.dropColumns(table, ['enchant_level']);
  }
};
