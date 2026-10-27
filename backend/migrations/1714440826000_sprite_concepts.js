exports.shorthands = undefined;

// The kept concept of a sprite subject (an entity, or one appearance variant):
// the concept image the GPU box drew, kept so later sheets can reuse it.
//   concept_key       our stored copy of the image (never deleted by "Delete generated")
//   box_concept_path  where the box holds it, valid only for box_origin + provider_id
// sprite_sets.note carries a short admin-visible message about a row (e.g. a fallback).
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS sprite_concepts (
      id serial PRIMARY KEY,
      entity_type_id int NOT NULL REFERENCES entity_types(id) ON DELETE CASCADE,
      appearance_variant smallint NULL,
      concept_key text NOT NULL,
      box_concept_path text NOT NULL,
      provider_id int NULL,
      box_origin text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS sprite_concepts_one_per_subject
      ON sprite_concepts (entity_type_id, COALESCE(appearance_variant, 0));
    ALTER TABLE sprite_sets ADD COLUMN IF NOT EXISTS note text;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE sprite_sets DROP COLUMN IF EXISTS note;
    DROP INDEX IF EXISTS sprite_concepts_one_per_subject;
    DROP TABLE IF EXISTS sprite_concepts;
  `);
};
