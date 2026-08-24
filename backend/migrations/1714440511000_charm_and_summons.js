exports.shorthands = undefined;

// The Druid's charm (spec 8.2, SOMET-473).
//
// SLOT NOTE: the plan named 1714440403000. That block is long gone -- the
// progression epic's own migrations already run to 1714440510000 -- so this
// takes the next free slot instead. Nothing in this migration depends on
// ordering beyond `characters` existing.
//
// charmed_by_character_id is ON DELETE SET NULL, never CASCADE. Deleting a
// character must RELEASE its pets, not delete the creatures out of the world:
// a CASCADE here would let a player wipe a pack off the map by deleting their
// own druid, and world_creatures rows are shared world state, not per-character
// state.
//
// charm_expires_at is the only expiry authority for a persisted charm. Nothing
// clears these columns on a timer -- every read filters `charm_expires_at >
// now()` -- so a crash mid-charm cannot leave a permanent pet behind, and the
// in-memory release in CreatureSim.tick and the durable rule cannot disagree
// about when a charm ended.
//
// NO faction column changes. entity_types.faction's CHECK allows exactly
// ('hostile','guard'); the charm's `'charmed'` faction is IN-MEMORY ONLY
// (CreatureSim.charm) and is never persisted anywhere, which is why the
// constraint needs no third value. Do not "helpfully" add one.

exports.up = (pgm) => {
  pgm.addColumns('world_creatures', {
    charmed_by_character_id: {
      type: 'integer', references: 'characters', onDelete: 'SET NULL',
    },
    charm_expires_at: { type: 'timestamptz' },
  });

  // AN OWNER REQUIRES AN EXPIRY. One direction, deliberately, and NOT the
  // biconditional `(a IS NULL) = (b IS NULL)` the plan specified.
  //
  // The biconditional is the obvious way to write "both or neither" and it is
  // WRONG here, in a way only the database can show you: `ON DELETE SET NULL`
  // above nulls the referencing column and ONLY that column, so deleting a
  // character who holds a live pet leaves charm_expires_at set with no owner --
  // and the biconditional then REJECTS the SET NULL, making the DELETE fail
  // with a check-constraint violation. Releasing a dead character's pets is the
  // entire reason that FK is SET NULL rather than CASCADE, so a constraint that
  // forbids the release defeats the column it is guarding.
  // `deleting a character releases its pets rather than deleting them` in
  // charm_summons_db.test.js is red against the biconditional.
  //
  // The half that actually matters is preserved in full: an owner with no
  // expiry is a PERMANENT PET, and that is unrepresentable. The other half --
  // an expiry with no owner -- is inert: every read keys on
  // charmed_by_character_id (the partial index below indexes exactly those
  // rows), so an orphaned timestamp is a value nothing consults, and the next
  // charm overwrites both columns together.
  pgm.addConstraint('world_creatures', 'world_creatures_charm_pair_check',
    'CHECK (charmed_by_character_id IS NULL OR charm_expires_at IS NOT NULL)');

  // Partial: the overwhelming majority of world_creatures rows are never
  // charmed, and the only query is "this character's live pets".
  pgm.createIndex('world_creatures', ['charmed_by_character_id'], {
    name: 'world_creatures_charmed_by_idx',
    where: 'charmed_by_character_id IS NOT NULL',
  });

  pgm.createTable('character_summons', {
    id: 'id',
    character_id: { type: 'integer', notNull: true, references: 'characters', onDelete: 'CASCADE' },
    creature_type: { type: 'text', notNull: true },
    level: { type: 'integer', notNull: true },
    charmed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  // The budget is a SUM of levels, so a level of 0 or below would be a summon
  // that costs nothing -- an unbounded swarm expressed in data rather than in
  // code. charm.js's canSummon refuses the same values; this is the durable
  // half of that pair, for rows any future writer inserts.
  pgm.addConstraint('character_summons', 'character_summons_level_check', 'CHECK (level >= 1)');
  // The roster is a SET of (character, type, level) -- "every creature ever
  // charmed" (spec 8.2) -- not a log of every charm EVENT. Without this a druid
  // who re-charms the same wolf twenty times gets twenty identical roster rows
  // and the re-summon list becomes unusable.
  pgm.addConstraint('character_summons', 'character_summons_unique',
    { unique: ['character_id', 'creature_type', 'level'] });
  pgm.createIndex('character_summons', 'character_id');
};

exports.down = (pgm) => {
  pgm.dropTable('character_summons');
  pgm.dropIndex('world_creatures', ['charmed_by_character_id'],
    { name: 'world_creatures_charmed_by_idx' });
  pgm.dropConstraint('world_creatures', 'world_creatures_charm_pair_check');
  pgm.dropColumns('world_creatures', ['charmed_by_character_id', 'charm_expires_at']);
};
