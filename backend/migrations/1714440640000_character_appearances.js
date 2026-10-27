exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('character_appearances', {
    entity_type_id: { type: 'integer', notNull: true, references: 'entity_types' },
    variant: { type: 'smallint', notNull: true },
    label: { type: 'text', notNull: true },
    image: { type: 'text' },
    sprite: { type: 'jsonb' },
    render_mode: { type: 'text' },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('character_appearances', 'character_appearances_pkey', {
    primaryKey: ['entity_type_id', 'variant'],
  });
  pgm.addConstraint('character_appearances', 'character_appearances_variant_check',
    'CHECK (variant BETWEEN 1 AND 5)');
  pgm.addConstraint('character_appearances', 'character_appearances_render_mode_check',
    "CHECK (render_mode IS NULL OR render_mode IN ('static', 'animated'))");

  // Five stable cosmetic slots for every playable class and any retired class
  // still referenced by a character. Null art falls back to the class art.
  pgm.sql(`
    INSERT INTO character_appearances (entity_type_id, variant, label)
    SELECT ids.entity_type_id, v, 'Appearance ' || v
      FROM (
        SELECT id AS entity_type_id FROM entity_types WHERE is_playable = true
        UNION
        SELECT DISTINCT entity_type_id FROM characters
      ) ids
      CROSS JOIN generate_series(1, 5) v
  `);

  pgm.addColumns('characters', {
    appearance_variant: { type: 'smallint', notNull: true, default: 1 },
  });
  pgm.addConstraint('characters', 'characters_appearance_fk', {
    foreignKeys: {
      columns: ['entity_type_id', 'appearance_variant'],
      references: 'character_appearances(entity_type_id, variant)',
    },
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint('characters', 'characters_appearance_fk');
  pgm.dropColumns('characters', ['appearance_variant']);
  pgm.dropTable('character_appearances');
};
