exports.shorthands = undefined;

exports.up = (pgm) => {
  // An item's base gold worth. Buy = value, sell = floor(value/2).
  pgm.addColumns('item_types', {
    value: { type: 'integer', notNull: true, default: 0 },
  });
  // Starting, tunable values derived from what an item actually does.
  // Currency (gold) stays 0 so it can never be sold to a merchant.
  pgm.sql(`UPDATE item_types SET value = 10 + (damage * 2)::int WHERE category = 'weapon'`);
  pgm.sql(`UPDATE item_types SET value = 10 + (COALESCE(defense,0) * 3)::int WHERE category = 'armor'`);
  pgm.sql(`UPDATE item_types SET value = 2 WHERE category = 'ammo'`);
  pgm.sql(`UPDATE item_types SET value = 0 WHERE category = 'currency'`);

  pgm.addColumns('villages', {
    merchant_x: { type: 'real' },
    merchant_y: { type: 'real' },
  });

  pgm.createTable('merchant_stock', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    world_id: { type: 'uuid', notNull: true, references: 'worlds', onDelete: 'CASCADE' },
    village_id: { type: 'uuid', notNull: true, references: 'villages', onDelete: 'CASCADE' },
    item_type_id: { type: 'integer', notNull: true, references: 'item_types', onDelete: 'CASCADE' },
    price: { type: 'integer', notNull: true },
    // NULL = base catalog (infinite, never expires). Set = a player buyback row.
    seller_user_id: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    expires_at: { type: 'timestamptz' },
    quantity: { type: 'integer', notNull: true, default: 1 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('merchant_stock', 'village_id');
};

exports.down = (pgm) => {
  pgm.dropTable('merchant_stock');
  pgm.dropColumns('villages', ['merchant_x', 'merchant_y']);
  pgm.dropColumns('item_types', ['value']);
};
