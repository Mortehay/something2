exports.up = (pgm) => {
  pgm.addColumns('item_types', {
    stackable: { type: 'boolean', notNull: true, default: false },
    // Self-referencing: the ammo item this weapon consumes. RESTRICT (not
    // CASCADE): deleting `arrow` while a bow points at it must fail loudly
    // rather than silently deleting the bow.
    ammo_type_id: { type: 'integer', references: 'item_types', onDelete: 'RESTRICT' },
    aoe_radius: { type: 'real' },
  });

  // quantity > 0 is load-bearing: it makes spending the last unit a constraint
  // violation rather than a silent negative, so Postgres enforces the invariant
  // instead of every call site remembering to.
  pgm.addColumns('player_items', {
    quantity: { type: 'integer', notNull: true, default: 1 },
  });
  pgm.addConstraint('player_items', 'player_items_quantity_check', 'CHECK (quantity > 0)');
  pgm.addColumns('world_items', {
    quantity: { type: 'integer', notNull: true, default: 1 },
  });
  pgm.addConstraint('world_items', 'world_items_quantity_check', 'CHECK (quantity > 0)');

  // 'ammo' joins the category enum.
  pgm.dropConstraint('item_types', 'item_types_category_check');
  pgm.addConstraint('item_types', 'item_types_category_check',
    "CHECK (category IN ('weapon','armor','ammo'))");

  // Category-conditional required fields, matching the weapon/armor pattern:
  // the DB must reject an item that can never work.
  pgm.addConstraint('item_types', 'item_types_ammo_fields_check',
    "CHECK (category <> 'ammo' OR (stackable = true AND kind IS NULL))");
  // A detonating projectile has nothing left to pierce with; allowing both
  // makes "what happens on impact" ambiguous.
  pgm.addConstraint('item_types', 'item_types_aoe_pierce_check',
    'CHECK (aoe_radius IS NULL OR pierce IS NULL OR pierce <= 1)');
  // A melee weapon with ammo_type_id set would silently never check it.
  //
  // `kind IS NOT NULL` is required, not redundant. A CHECK rejects a row only
  // when its expression is FALSE — NULL passes. Armor and ammo rows both have
  // kind IS NULL, so the shorter form `ammo_type_id IS NULL OR kind =
  // 'projectile'` evaluates to (FALSE OR NULL) = NULL for them and is
  // therefore VACUOUS: an armor row could carry an ammo_type_id that nothing
  // ever reads. Verified against the live DB before this was tightened.
  pgm.addConstraint('item_types', 'item_types_ammo_ref_check',
    "CHECK (ammo_type_id IS NULL OR (kind IS NOT NULL AND kind = 'projectile'))");

  // Ammo rows FIRST — the weapon updates below reference them by FK.
  pgm.sql(`
    INSERT INTO item_types (name, category, stackable, kind, damage, cooldown, mana_cost, stamina_cost)
    VALUES ('arrow','ammo',true,NULL,0,0,0,0),
           ('bolt', 'ammo',true,NULL,0,0,0,0),
           ('stone','ammo',true,NULL,0,0,0,0)
    ON CONFLICT (name) DO NOTHING;
  `);

  // Wire weapons to ammo by name subquery. A missing row on either side
  // updates nothing rather than aborting the migration — the same guarded
  // pattern the 3b-2b loot seed uses.
  for (const [weapon, ammo] of [['bow', 'arrow'], ['arbalest', 'bolt'], ['sling', 'stone']]) {
    pgm.sql(`UPDATE item_types SET ammo_type_id = (SELECT id FROM item_types WHERE name = '${ammo}')
             WHERE name = '${weapon}' AND EXISTS (SELECT 1 FROM item_types WHERE name = '${ammo}');`);
  }

  // darts deliberately get NO ammo — the weak-but-free option.
  for (const [staff, radius] of [['flame staff', 90], ['storm staff', 70], ['archmage staff', 110]]) {
    pgm.sql(`UPDATE item_types SET aoe_radius = ${radius} WHERE name = '${staff}';`);
  }
};

exports.down = (pgm) => {
  // Null the FKs before deleting the ammo rows, or ON DELETE RESTRICT blocks
  // the DELETE and aborts the rollback.
  pgm.sql(`UPDATE item_types SET ammo_type_id = NULL;`);
  pgm.sql(`DELETE FROM item_types WHERE category = 'ammo';`);
  pgm.dropConstraint('item_types', 'item_types_ammo_ref_check');
  pgm.dropConstraint('item_types', 'item_types_aoe_pierce_check');
  pgm.dropConstraint('item_types', 'item_types_ammo_fields_check');
  pgm.dropConstraint('item_types', 'item_types_category_check');
  pgm.addConstraint('item_types', 'item_types_category_check',
    "CHECK (category IN ('weapon','armor'))");
  pgm.dropConstraint('world_items', 'world_items_quantity_check');
  pgm.dropColumns('world_items', ['quantity']);
  pgm.dropConstraint('player_items', 'player_items_quantity_check');
  pgm.dropColumns('player_items', ['quantity']);
  pgm.dropColumns('item_types', ['stackable', 'ammo_type_id', 'aoe_radius']);
};
