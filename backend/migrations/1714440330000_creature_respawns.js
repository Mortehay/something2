exports.shorthands = undefined;

// SOMET-309: the respawn queue. A creature's death deletes its world_creatures
// row (authority/loot.js's commitCreatureDeath) and, in the SAME transaction,
// writes one row here. A sweep drains due rows back into world_creatures.
//
// WHY A SEPARATE TABLE RATHER THAN A COLUMN ON world_creatures: a pending
// respawn is not a creature. Keeping a dead creature's row around with a
// `dead_until` timestamp would put a non-entity in the table every reader
// treats as "things that exist in the world" -- the authority's chunk loader,
// the admin overview, worlds.creature_count, and populateWorld's own wipe
// predicate would each need a new exclusion, and any one of them forgetting it
// ships an invisible unkillable creature. Nothing is in both tables at once.
//
// WHY NO hp/damage/defense COLUMNS: creatureLevel.js's scaleCreature(base,
// level) derives all three from the entity_types row plus a level, which is
// exactly what placeMapCreatures already does at seeding time. Storing `type`
// and `level` is therefore sufficient, and it means a catalog rebalance
// applies to every creature that respawns after it rather than resurrecting
// pre-nerf stats forever.
exports.up = (pgm) => {
  pgm.createTable('creature_respawns', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    // CASCADE matches world_creatures' own FK: a deleted world must not strand
    // queue rows that can never be delivered.
    world_id: {
      type: 'uuid', notNull: true, references: 'worlds', onDelete: 'CASCADE',
    },
    type: { type: 'text', notNull: true },
    x: { type: 'real', notNull: true },
    y: { type: 'real', notNull: true },
    level: { type: 'integer', notNull: true },
    respawn_at: { type: 'timestamptz', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // The sweep's only query is "everything due, oldest first".
  pgm.createIndex('creature_respawns', 'respawn_at', { name: 'creature_respawns_due_index' });
  // The load-time backstop counts pending rows for one world.
  pgm.createIndex('creature_respawns', 'world_id', { name: 'creature_respawns_world_id_index' });
};

exports.down = (pgm) => {
  pgm.dropTable('creature_respawns');
};
