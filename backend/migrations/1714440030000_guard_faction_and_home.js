exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns('entity_types', {
    faction: { type: 'text', notNull: true, default: 'hostile' },
  });
  pgm.addConstraint('entity_types', 'entity_types_faction_check', {
    check: "faction IN ('hostile','guard')",
  });
  pgm.addColumns('world_creatures', {
    home_x: { type: 'real' },
    home_y: { type: 'real' },
  });
  // The village gate guard. Tough on purpose: it must survive the hostiles it
  // fights. is_creature=true so it loads through the normal creature path.
  pgm.sql(
    `INSERT INTO entity_types
       (name, color, walkable, spawn_tiles, chance, hp, max_hp, defense, resistances, is_creature, faction)
     VALUES
       ('Village Guard', '#3f6fb5', false, '[]', 0, 300, 300, 10, '{}', true, 'guard')
     ON CONFLICT (name) DO NOTHING`
  );
};

exports.down = (pgm) => {
  pgm.sql("DELETE FROM entity_types WHERE name = 'Village Guard'");
  pgm.dropColumns('world_creatures', ['home_x', 'home_y']);
  pgm.dropConstraint('entity_types', 'entity_types_faction_check');
  pgm.dropColumns('entity_types', ['faction']);
};
