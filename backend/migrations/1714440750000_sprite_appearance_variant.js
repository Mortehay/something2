exports.shorthands = undefined;

// Every sprite job used to target a whole entity_type. Playable classes now
// also want a directional sprite PER appearance variant (character_appearances
// has had an unused `sprite` jsonb column since SOMET-629's generated-portrait
// work; this is what finally writes it). appearance_variant is NULL for a
// plain entity job -- the old one-per-entity behaviour -- and 1-5 for a job
// that targets one of a class's five character_appearances rows instead.
exports.up = (pgm) => {
  pgm.addColumns('sprite_sets', {
    appearance_variant: { type: 'smallint' },
  });
  pgm.addConstraint('sprite_sets', 'sprite_sets_appearance_variant_check',
    'CHECK (appearance_variant IS NULL OR appearance_variant BETWEEN 1 AND 5)');

  // Replaces sprite_sets_one_live_per_entity: COALESCE(.., 0) so NULL and each
  // of 1-5 all collide with themselves but not each other, keeping "one live
  // job per (entity, variant)" instead of the old "one live job per entity" --
  // otherwise queuing all 5 of a class's variants would only ever let one run.
  pgm.dropIndex('sprite_sets', ['entity_type_id'], { name: 'sprite_sets_one_live_per_entity' });
  pgm.sql(`
    CREATE UNIQUE INDEX sprite_sets_one_live_per_entity_variant
      ON sprite_sets (entity_type_id, COALESCE(appearance_variant, 0))
      WHERE entity_type_id IS NOT NULL AND status IN ('queued','running')
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP INDEX sprite_sets_one_live_per_entity_variant');
  pgm.createIndex('sprite_sets', ['entity_type_id'], {
    name: 'sprite_sets_one_live_per_entity',
    unique: true,
    where: "entity_type_id IS NOT NULL AND status IN ('queued','running')",
  });
  pgm.dropConstraint('sprite_sets', 'sprite_sets_appearance_variant_check');
  pgm.dropColumns('sprite_sets', ['appearance_variant']);
};
