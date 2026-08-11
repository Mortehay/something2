exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('chest_loot', {
    id: 'id',
    level_min: { type: 'integer', notNull: true },
    level_max: { type: 'integer', notNull: true },
    item_type_id: { type: 'integer', notNull: true, references: 'item_types', onDelete: 'CASCADE' },
    chance: { type: 'numeric', notNull: true },
    min_qty: { type: 'integer', notNull: true, default: 1 },
    max_qty: { type: 'integer', notNull: true, default: 1 },
  });
  pgm.addConstraint('chest_loot', 'chest_loot_level_check', 'CHECK (level_max >= level_min AND level_min >= 1)');
  pgm.addConstraint('chest_loot', 'chest_loot_chance_check', 'CHECK (chance > 0 AND chance <= 1)');
  pgm.addConstraint('chest_loot', 'chest_loot_qty_check', 'CHECK (min_qty >= 1 AND max_qty >= min_qty)');
  pgm.createIndex('chest_loot', ['level_min', 'level_max']);
};

exports.down = (pgm) => {
  pgm.dropTable('chest_loot');
};
