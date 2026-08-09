exports.shorthands = undefined;

// Characters (SOMET-257). Until now one account was one player: position,
// respawn bind, progression, inventory and equipment all hung off users.id, so
// an account had exactly one playthrough. This migration introduces the
// characters table and re-keys all five of those tables onto it.
//
// THE 8-SLOT CAP IS A SCHEMA INVARIANT, NOT AN APPLICATION COUNT. A COUNT(*)
// check is racy -- two concurrent creates on the last slot both read 7 and both
// insert. `slot smallint CHECK (slot BETWEEN 1 AND 8)` plus
// UNIQUE(user_id, slot) makes a ninth character unrepresentable, so the loser
// of a race gets a constraint violation the API turns into a 409.
//
// characters.name is GLOBALLY unique, not per-account: other players see it
// in-world, so two characters called "Gorm" would be ambiguous. citext matches
// how users.username is declared (1714440025000).
//
// THE BACKFILL IS NON-DESTRUCTIVE. 1714440025000 truncated three of these
// tables because they held anonymous test detritus; this data is real player
// state and must survive. Characters are inserted, rows are repointed, and only
// then is user_id dropped.

// pk/newPk are null for player_items: its primary key is `id` and does not
// involve the ownership column, so only the index moves.
const STATE_TABLES = [
  { table: 'world_players', pk: ['world_id', 'user_id'], newPk: ['world_id', 'character_id'] },
  { table: 'player_binds', pk: ['user_id'], newPk: ['character_id'] },
  { table: 'player_progression', pk: ['user_id'], newPk: ['character_id'] },
  { table: 'player_equipment', pk: ['user_id', 'slot'], newPk: ['character_id', 'slot'] },
  { table: 'player_items', pk: null, newPk: null },
];

exports.up = (pgm) => {
  pgm.createExtension('citext', { ifNotExists: true });

  pgm.createTable('characters', {
    id: 'id',
    user_id: { type: 'integer', notNull: true, references: 'users', onDelete: 'CASCADE' },
    slot: { type: 'smallint', notNull: true },
    name: { type: 'citext', notNull: true },
    entity_type_id: { type: 'integer', notNull: true, references: 'entity_types' },
    starting_loadout_granted_at: { type: 'timestamptz', notNull: false, default: null },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('characters', 'characters_slot_check', 'CHECK (slot BETWEEN 1 AND 8)');
  pgm.addConstraint('characters', 'characters_user_slot_unique', { unique: ['user_id', 'slot'] });
  pgm.addConstraint('characters', 'characters_name_unique', { unique: ['name'] });
  pgm.createIndex('characters', 'user_id');

  // 1. Nullable column on every state table.
  for (const { table } of STATE_TABLES) {
    pgm.addColumns(table, {
      character_id: { type: 'integer', notNull: false, default: null },
    });
  }

  // 2. One slot-1 Warrior per user that holds ANY player state. Name collision
  //    is impossible by construction: characters.name and users.username are
  //    both globally unique citext, and every backfilled name IS a username.
  //    A user with no state gets no character and will create one on first
  //    login -- a blanket one-per-user would hand a character to every
  //    throwaway test registration too.
  pgm.sql(`
    INSERT INTO characters (user_id, slot, name, entity_type_id, starting_loadout_granted_at)
    SELECT u.id, 1, u.username,
           (SELECT id FROM entity_types WHERE name = 'Warrior'),
           u.starting_loadout_granted_at
      FROM users u
     WHERE EXISTS (SELECT 1 FROM world_players      WHERE user_id = u.id)
        OR EXISTS (SELECT 1 FROM player_binds       WHERE user_id = u.id)
        OR EXISTS (SELECT 1 FROM player_progression WHERE user_id = u.id)
        OR EXISTS (SELECT 1 FROM player_items       WHERE user_id = u.id)
        OR EXISTS (SELECT 1 FROM player_equipment   WHERE user_id = u.id)
  `);

  // 3. Repoint. Still reading user_id, which still exists.
  for (const { table } of STATE_TABLES) {
    pgm.sql(`
      UPDATE ${table} t SET character_id = c.id
        FROM characters c
       WHERE c.user_id = t.user_id AND c.slot = 1
    `);
  }

  // 4. Swap the keys, then drop user_id. Any row whose user_id no longer
  //    resolves to a character is orphaned state for a deleted account; delete
  //    it rather than failing the migration on the NOT NULL. (Step 2 creates a
  //    character for every user that holds a row, so this can only fire for a
  //    row whose user_id has no users entry at all.)
  for (const { table, pk, newPk } of STATE_TABLES) {
    pgm.sql(`DELETE FROM ${table} WHERE character_id IS NULL`);
    pgm.sql(`ALTER TABLE ${table} ALTER COLUMN character_id SET NOT NULL`);
    pgm.addConstraint(table, `${table}_character_fk`, {
      foreignKeys: { columns: 'character_id', references: 'characters(id)', onDelete: 'CASCADE' },
    });
    if (pk) {
      pgm.dropConstraint(table, `${table}_pkey`);
      pgm.addConstraint(table, `${table}_pkey`, { primaryKey: newPk });
    }
    // Dropping the column takes its FK to users and any index on it with it.
    pgm.dropColumns(table, ['user_id']);
  }
  pgm.createIndex('player_items', 'character_id');

  // 5. starting_loadout_granted_at is now a fact about a character, not an
  //    account: the loadout is class-dependent, so a second character must get
  //    its own. The column was carried onto every backfilled character in
  //    step 2 -- dropping it before that copy would re-grant a starter kit to
  //    every existing player on their next join.
  pgm.dropColumns('users', ['starting_loadout_granted_at']);
};

exports.down = (pgm) => {
  // LOSSY BY DESIGN, FOR ACCOUNTS WITH MORE THAN ONE CHARACTER. There is only
  // one user_id to restore to, so the lowest-slot character's state is kept and
  // slots 2-8 are dropped along with the table. This is acceptable only because
  // `down` exists to unwind a bad deploy on a database that has not yet grown
  // multi-character accounts; it is NOT a general-purpose rollback, and running
  // it against a live multi-character server destroys real player data.
  pgm.addColumns('users', {
    starting_loadout_granted_at: { type: 'timestamptz', notNull: false, default: null },
  });
  pgm.sql(`
    UPDATE users u SET starting_loadout_granted_at = c.starting_loadout_granted_at
      FROM characters c
     WHERE c.user_id = u.id AND c.slot = (SELECT MIN(slot) FROM characters WHERE user_id = u.id)
  `);

  for (const { table, pk } of [...STATE_TABLES].reverse()) {
    pgm.addColumns(table, { user_id: { type: 'integer', notNull: false, default: null } });
    pgm.sql(`
      UPDATE ${table} t SET user_id = c.user_id
        FROM characters c
       WHERE c.id = t.character_id
         AND c.slot = (SELECT MIN(slot) FROM characters WHERE user_id = c.user_id)
    `);
    pgm.sql(`DELETE FROM ${table} WHERE user_id IS NULL`);
    pgm.sql(`ALTER TABLE ${table} ALTER COLUMN user_id SET NOT NULL`);
    pgm.addConstraint(table, `${table}_user_fk`, {
      foreignKeys: { columns: 'user_id', references: 'users(id)', onDelete: 'CASCADE' },
    });
    if (pk) {
      pgm.dropConstraint(table, `${table}_pkey`);
      pgm.addConstraint(table, `${table}_pkey`, { primaryKey: pk });
    }
    pgm.dropColumns(table, ['character_id']);
  }

  pgm.dropTable('characters');
};

exports.STATE_TABLES = STATE_TABLES;
