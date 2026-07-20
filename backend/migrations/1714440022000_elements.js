exports.up = (pgm) => {
  pgm.addColumns('entity_types', {
    defense: { type: 'real', notNull: true, default: 0 },
    // Same shape and semantics as item_types.resistances: {element: 0..1}.
    resistances: { type: 'jsonb', notNull: true, default: '{}' },
  });

  // THE DATABASE CONTAINS EXACTLY ONE CREATURE (`Wolf`); everything else is
  // scenery. With one creature, resistances create no matchup — they are just
  // a flat nerf to one element. So this slice adds three more.
  //
  // This is cheap: spawnChunkCreatures picks uniformly from the creature list
  // by hash, so a new row spawns automatically with no spawn-table wiring, and
  // creatures render from `color`, so no sprites are needed. A creature type
  // is any entity_types row with is_creature = true.
  //
  // Profiles are chosen so no single element beats everything: each element is
  // resisted by someone, and each creature has an element it cannot resist.
  // Nothing resists arcane — arcane carries no status rider, so reliable
  // unresisted damage is the generalist's compensation.
  pgm.sql(`
    INSERT INTO entity_types (name, color, walkable, spawn_tiles, chance, is_creature,
                              hp, max_hp, strength, constitution, defense, resistances)
    VALUES
      ('Slime',    '#27ae60', true, '[]'::jsonb, 0.1, true, 18, 18, 4, 6, 0,
       '{"fire":0.6,"physical":0.3}'::jsonb),
      ('Skeleton', '#ecf0f1', true, '[]'::jsonb, 0.1, true, 14, 14, 6, 4, 2,
       '{"ice":0.6,"physical":0.2}'::jsonb),
      ('Bat',      '#8e44ad', true, '[]'::jsonb, 0.1, true,  8,  8, 3, 2, 0,
       '{"lightning":0.5}'::jsonb)
    ON CONFLICT (name) DO NOTHING;
  `);

  // Wolf stays the neutral baseline: no resistances, so every element works on
  // it. Set max_hp to match hp — the existing row has max_hp = 0, which is
  // wrong data that creatures.js happens to paper over by using hp for both.
  pgm.sql(`UPDATE entity_types SET max_hp = hp WHERE name = 'Wolf' AND max_hp = 0;`);

  // Storm staff pays for carrying all three lightning riders: it becomes the
  // worst staff in the game by damage-per-mana. An invariant test enforces
  // this, because a future rebalance could otherwise quietly restore
  // dominance with every other test still green.
  pgm.sql(`UPDATE item_types SET damage = 14, cooldown = 1.10, mana_cost = 34
           WHERE name = 'storm staff';`);
};

exports.down = (pgm) => {
  pgm.sql(`UPDATE item_types SET damage = 19, cooldown = 0.95, mana_cost = 24
           WHERE name = 'storm staff';`);
  // World rows referencing these creatures must go first, or the delete
  // fails (or orphans live creatures pointing at a vanished type).
  pgm.sql(`DELETE FROM world_creatures WHERE type IN ('Slime','Skeleton','Bat');`);
  pgm.sql(`DELETE FROM entity_types WHERE name IN ('Slime','Skeleton','Bat');`);
  pgm.dropColumns('entity_types', ['defense', 'resistances']);
};
