/* eslint-disable camelcase */

// SOMET-535. A home for art belonging to subjects that have no row of their own.
//
// Tiles and entities keep their `image` column, and items will use the `icon`
// column item_types already has (empty on all 189 rows today). This table is
// for the two subjects that cannot follow that pattern:
//
//   * CLASS SKILLS live in seeds/data/skills.js and have no database table at
//     all -- 300 of them, and the only skill-ish table is stone_instances.
//   * PASSIVE ART IS PER LABEL, not per node. 1852 passive_nodes rows carry
//     only 128 distinct labels ("Focus" appears 240 times), so there is no
//     single row that owns the image. Hanging it on a node would also lose it:
//     seed-passive-tree upserts by `key` and prunes stale ids under --force.
//
// A stable (subject_kind, subject_key) survives both of those. The key is the
// skill's id or the passive label text -- authored values, not generated ones.
//
// WHY NOT ONE TABLE FOR EVERYTHING. Moving tiles, entities and items here too
// would be more uniform and would orphan three working columns for no gain;
// the existing registry already models "different subjects write to different
// places", so each subject keeps whatever home it already has.

exports.up = (pgm) => {
  pgm.createTable('catalog_art', {
    subject_kind: { type: 'text', notNull: true },
    subject_key: { type: 'text', notNull: true },
    // The object-store key, the same shape the other catalogs store: a path
    // into the sprites bucket, not the image bytes.
    image: { type: 'text', notNull: true },
    // Which provider drew it, for the same reason art_jobs records it: when a
    // batch comes out wrong, the first question is which model produced it.
    // SET NULL rather than CASCADE -- deleting a provider must not delete the
    // art it made.
    provider_id: { type: 'integer', references: 'ai_providers', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // One image per subject. Regenerating replaces it, which is what an upsert
  // on this key gives; keeping a history here would make "does this subject
  // have art" ambiguous, and the object store already holds every version
  // under its own job id.
  pgm.addConstraint('catalog_art', 'catalog_art_pkey',
    { primaryKey: ['subject_kind', 'subject_key'] });
};

// Safe to reverse: this table is a pointer to art, not the art. The images
// stay in the object store under their job keys, so a down-then-up loses the
// association but nothing that was generated.
exports.down = (pgm) => {
  pgm.dropTable('catalog_art');
};
