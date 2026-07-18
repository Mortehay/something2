const ELEMENTS = ['physical', 'arcane', 'fire', 'ice', 'lightning'];
const SLOTS = ['main_hand', 'off_hand', 'head', 'chest', 'hands', 'feet', 'ring1', 'ring2'];

exports.up = (pgm) => {
  // 1. Generalize the weapon catalog into an item catalog.
  pgm.renameTable('weapon_types', 'item_types');
  pgm.addColumns('item_types', {
    category: { type: 'text', notNull: true, default: 'weapon' },
    slot: { type: 'text' },
    two_handed: { type: 'boolean', notNull: true, default: false },
    defense: { type: 'real' },
    resistances: { type: 'jsonb' },
  });
  pgm.sql(`UPDATE item_types SET slot = 'main_hand' WHERE category = 'weapon' AND slot IS NULL;`);
  pgm.sql(`UPDATE item_types SET two_handed = true WHERE name = 'halberd';`);
  pgm.alterColumn('item_types', 'category', { default: null });
  // `kind` was NOT NULL under the weapon-only schema; armor rows legitimately have
  // kind IS NULL, and item_types_weapon_fields_check (below) already enforces that
  // weapons must have a kind. Relax the column-level constraint accordingly.
  pgm.alterColumn('item_types', 'kind', { notNull: false });

  pgm.addConstraint('item_types', 'item_types_category_check',
    "CHECK (category IN ('weapon','armor'))");
  pgm.addConstraint('item_types', 'item_types_slot_check',
    `CHECK (slot IS NULL OR slot IN (${SLOTS.map((s) => `'${s}'`).join(',')}))`);
  pgm.addConstraint('item_types', 'item_types_element_check',
    `CHECK (element IS NULL OR element IN (${ELEMENTS.map((e) => `'${e}'`).join(',')}))`);
  // Category-conditional required fields — the DB must reject an item that can never work.
  pgm.addConstraint('item_types', 'item_types_weapon_fields_check', `CHECK (
    category <> 'weapon' OR (
      kind IS NOT NULL
      AND (kind <> 'melee' OR (reach IS NOT NULL AND arc_width IS NOT NULL))
      AND (kind <> 'projectile' OR (range IS NOT NULL AND projectile_speed IS NOT NULL AND projectile_radius IS NOT NULL))
    ))`);
  pgm.addConstraint('item_types', 'item_types_armor_fields_check',
    "CHECK (category <> 'armor' OR (slot IS NOT NULL AND defense IS NOT NULL))");

  pgm.sql(`
    INSERT INTO item_types (name, category, slot, defense, resistances, kind, damage, cooldown, mana_cost)
    VALUES
      ('leather-vest', 'armor', 'chest', 2, '{}'::jsonb,                 NULL, 0, 0, 0),
      ('arcane-ward',  'armor', 'head',  1, '{"arcane":0.3}'::jsonb,     NULL, 0, 0, 0)
    ON CONFLICT (name) DO NOTHING;
  `);

  // 2. Account-wide item instances.
  pgm.createTable('player_items', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'text', notNull: true },
    item_type_id: { type: 'integer', notNull: true, references: 'item_types', onDelete: 'CASCADE' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('player_items', 'user_id');

  // 3. Account-wide paper-doll. An instance may occupy at most one slot.
  pgm.createTable('player_equipment', {
    user_id: { type: 'text', notNull: true },
    slot: { type: 'text', notNull: true },
    item_id: { type: 'uuid', notNull: true, references: 'player_items', onDelete: 'CASCADE' },
  }, {
    constraints: { primaryKey: ['user_id', 'slot'] },
  });
  pgm.addConstraint('player_equipment', 'player_equipment_slot_check',
    `CHECK (slot IN (${SLOTS.map((s) => `'${s}'`).join(',')}))`);
  pgm.addConstraint('player_equipment', 'player_equipment_item_unique', { unique: ['item_id'] });
};

exports.down = (pgm) => {
  pgm.dropTable('player_equipment');
  pgm.dropTable('player_items');
  // Delete ALL kind-IS-NULL rows, not just the two seeded armor rows: any
  // armor created via the item-types editor since this migration ran also
  // has kind IS NULL, and the alterColumn below (restoring kind NOT NULL)
  // errors on any surviving NULL, aborting the rollback halfway (after
  // player_equipment/player_items are already dropped). This makes the
  // rollback lossy for admin-authored armor — acceptable for a dev rollback,
  // but worth knowing before running it against a DB with real data.
  pgm.sql(`DELETE FROM item_types WHERE kind IS NULL;`);
  pgm.alterColumn('item_types', 'kind', { notNull: true });
  pgm.dropConstraint('item_types', 'item_types_armor_fields_check');
  pgm.dropConstraint('item_types', 'item_types_weapon_fields_check');
  pgm.dropConstraint('item_types', 'item_types_element_check');
  pgm.dropConstraint('item_types', 'item_types_slot_check');
  pgm.dropConstraint('item_types', 'item_types_category_check');
  pgm.dropColumns('item_types', ['category', 'slot', 'two_handed', 'defense', 'resistances']);
  pgm.renameTable('item_types', 'weapon_types');
};
