exports.up = (pgm) => {
  pgm.addColumn('item_types', {
    stamina_cost: { type: 'integer', notNull: true, default: 0 },
  });
  pgm.addConstraint('item_types', 'item_types_stamina_cost_check', 'CHECK (stamina_cost >= 0)');

  // Backfill the four already-seeded weapons with their catalog stamina costs.
  pgm.sql(`UPDATE item_types SET stamina_cost = 0 WHERE name = 'dagger'`);
  pgm.sql(`UPDATE item_types SET stamina_cost = 8 WHERE name = 'halberd'`);
  pgm.sql(`UPDATE item_types SET stamina_cost = 3 WHERE name = 'bow'`);
  pgm.sql(`UPDATE item_types SET stamina_cost = 0 WHERE name = 'magic-bolt'`);

  // 18 new weapons. ON CONFLICT DO NOTHING so a re-run (or a name an admin
  // already authored) cannot fail the migration.
  pgm.sql(`
    INSERT INTO item_types
      (name, category, slot, two_handed, kind, damage, cooldown, reach, arc_width,
       range, projectile_speed, projectile_radius, pierce, mana_cost, stamina_cost, element)
    VALUES
      ('knife',            'weapon','main_hand',false,'melee',       6,0.25, 70,0.5, NULL,NULL,NULL,NULL, 0,0, NULL),
      ('stick',            'weapon','main_hand',false,'melee',       7,0.35, 90,0.7, NULL,NULL,NULL,NULL, 0,0, NULL),
      ('club',             'weapon','main_hand',false,'melee',      10,0.45, 85,0.8, NULL,NULL,NULL,NULL, 0,2, NULL),
      ('short sword',      'weapon','main_hand',false,'melee',      11,0.45,100,0.9, NULL,NULL,NULL,NULL, 0,2, NULL),
      ('mid club',         'weapon','main_hand',false,'melee',      14,0.60,115,1.0, NULL,NULL,NULL,NULL, 0,4, NULL),
      ('long sword',       'weapon','main_hand',false,'melee',      15,0.65,140,1.2, NULL,NULL,NULL,NULL, 0,4, NULL),
      ('morning star',     'weapon','main_hand',false,'melee',      17,0.75,130,1.6, NULL,NULL,NULL,NULL, 0,6, NULL),
      ('two-handed sword', 'weapon','main_hand',true, 'melee',      22,1.00,170,1.4, NULL,NULL,NULL,NULL, 0,9, NULL),
      ('scythe',           'weapon','main_hand',true, 'melee',      20,0.95,175,2.0, NULL,NULL,NULL,NULL, 0,8, NULL),
      ('pike',             'weapon','main_hand',true, 'melee',      19,0.85,200,0.5, NULL,NULL,NULL,NULL, 0,7, NULL),
      ('darts',            'weapon','main_hand',false,'projectile',  7,0.35,NULL,NULL, 350, 800, 6,1, 0,1, NULL),
      ('sling',            'weapon','main_hand',false,'projectile',  8,0.50,NULL,NULL, 450, 700, 8,1, 0,1, NULL),
      ('arbalest',         'weapon','main_hand',true, 'projectile', 20,1.20,NULL,NULL, 850,1100, 8,2, 0,5, NULL),
      ('apprentice staff', 'weapon','main_hand',false,'projectile', 10,0.55,NULL,NULL, 500, 650,10,1, 8,0, 'arcane'),
      ('frost staff',      'weapon','main_hand',false,'projectile', 13,0.70,NULL,NULL, 620, 650,12,1,16,0, 'ice'),
      ('flame staff',      'weapon','main_hand',false,'projectile', 16,0.80,NULL,NULL, 550, 600,14,1,18,0, 'fire'),
      ('storm staff',      'weapon','main_hand',true, 'projectile', 19,0.95,NULL,NULL, 700,1000,10,1,24,0, 'lightning'),
      ('archmage staff',   'weapon','main_hand',true, 'projectile', 24,1.10,NULL,NULL, 800, 850,14,1,32,0, 'arcane')
    ON CONFLICT (name) DO NOTHING
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM item_types WHERE name IN (
      'knife','stick','club','short sword','mid club','long sword','morning star',
      'two-handed sword','scythe','pike','darts','sling','arbalest',
      'apprentice staff','frost staff','flame staff','storm staff','archmage staff'
    )
  `);
  pgm.dropConstraint('item_types', 'item_types_stamina_cost_check');
  pgm.dropColumn('item_types', 'stamina_cost');
};
