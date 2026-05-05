exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO entity_types (
      name, color, walkable, spawn_tiles, chance, 
      strength, dexterity, constitution, intelligence, wisdom, charisma,
      hp, max_hp, hp_regen_rate, mana, max_mana, mana_regen_rate
    ) VALUES (
      'Player', '#3B82F6', true, '[]', 0, 
      10, 10, 10, 10, 10, 10, 
      100, 100, 1, 50, 50, 0.5
    ) ON CONFLICT (name) DO NOTHING
  `);
};

exports.down = (pgm) => {
  pgm.sql("DELETE FROM entity_types WHERE name = 'Player'");
};
