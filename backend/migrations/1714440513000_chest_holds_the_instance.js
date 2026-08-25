/* eslint-disable camelcase */
exports.shorthands = undefined;

// SOMET-498. Depositing an affixed item in the account chest ("bank") and
// withdrawing it returned a plain white base item:
//
//   in:  rarity foxy, item_level 88, affixes [3.13, 11.5]
//   out: rarity white, item_level 1, affixes []   (and a NEW player_items id)
//
// `account_items` (1714440280000) keys on `item_type_id` alone, so
// accountChest.js's depositItem DELETEd the `player_items` row -- cascading its
// `player_item_affixes` rows away with it -- and withdrawItem INSERTed a brand
// new instance built from the catalog type. Rarity, item level and every rolled
// affix were destroyed by the round trip, in the one place players deliberately
// store the gear they care about.
//
// This is the SAME defect SOMET-484 fixed for merchant buyback stock
// (1714440512000), and it takes the same shape. Read that migration's header
// first; this one states only what differs.
//
// WHY A REFERENCE AND NOT A SNAPSHOT.
//
// Unchanged from 484, and if anything stronger here: `player_item_affixes
// .affix_type_id` is deliberately ON DELETE RESTRICT so that deleting a catalog
// affix cannot silently strip a stat off gear players are holding, and the
// admin affix CRUD (`PUT`/`DELETE /api/affix-types`) is live the whole time. A
// jsonb snapshot on `account_items` would carry a bare `affixTypeId` with no
// foreign key and route straight around that protection. A merchant buyback row
// lives three days; a CHEST row lives until the player takes it out, which is
// forever. The window in which a snapshot can rot is unbounded.
//
// So the chest HOLDS the instance. Depositing MOVES the `player_items` row off
// the character and onto an `account_items` row; withdrawing moves it back.
// Rarity, item_level and the affix rows are never read, never written and never
// copied, so there is no carry path that can be incomplete -- the round trip is
// lossless by construction rather than by careful copying.
//
// WHY THE POINTER LIVES ON `player_items`, NOT ON `account_items`.
//
// Same direction as 484, and the enumeration that justifies it was re-done for
// the chest rather than assumed. An `account_items` row is deleted from exactly
// three places, plus this migration's own down():
//
//   1. withdrawItem's `DELETE FROM account_items WHERE id = $1 AND user_id = $2`
//      -- the only explicit deleter in the codebase (grep: `account_items` has
//      no other DELETE and no other table references it).
//   2. `account_items.user_id -> users ON DELETE CASCADE` -- deleting an
//      account takes its chest.
//   3. `account_items.item_type_id -> item_types ON DELETE CASCADE` -- an admin
//      deleting a base type takes every stored copy of it.
//
// With the pointer on `account_items`, (2) and (3) are CASCADEs that no code
// site can hook: they would silently leave a `player_items` row owned by
// nobody, forever, invisible to every query in the codebase, and there is no
// constraint that would ever notice. With `player_items.account_item_id ... ON
// DELETE CASCADE`, all three clean themselves up and no future deleter has to
// know this exists. (1) is the single site that must be written carefully, and
// it is written carefully: withdrawItem DETACHES the instance before it deletes
// the container, so this CASCADE never fires on a live item. `SOMET-498: the
// container DELETE must not cascade the item away` in
// account_chest_instance_db.test.js is what pins that ordering.
//
// The second reason is the same as 484's: "an instance has exactly one holder"
// becomes a table-level CHECK on `player_items` instead of an invariant spread
// across three tables that nothing can express.
//
// EVERY EXISTING CHEST ROW IS BACKFILLED WITH AN INSTANCE, deliberately, rather
// than left to a legacy code path. 484 kept a "this stock row holds nothing, so
// mint a fresh one from the type" branch in buyStock because it genuinely needs
// one forever -- the infinite base catalog is permanently instance-less. The
// chest has no such class: after the backfill below, EVERY `account_items` row
// holds exactly one instance and depositItem is the only writer. Keeping a
// mint-from-the-type fallback in withdrawItem would therefore be a branch that
// is dead in practice and silently re-creates the exact bug this ticket is
// about if the detach ever stops matching (say, when a fourth holder column is
// added and the UPDATE predicate is not updated). withdrawItem refuses loudly
// instead, and the ROLLBACK leaves the container row intact, so nothing is
// lost. The backfill is lossless: a pre-498 chest row carries item_type_id,
// quantity and soulbound and nothing else, because nothing else survived the
// deposit that created it.
//
// STACKING. `account_items` carries `quantity` and `merchant_stock` did not,
// which is the one real difference from 484. Instance-held chest rows are NOT
// forced to quantity = 1: the chest now holds the instance, and a stack's
// quantity is a column ON that instance, so moving the row preserves a stack
// exactly and by construction -- forcing 1 would BREAK stacking rather than
// protect anything. What actually needs protecting is the property that makes
// that safe, and it belongs on `player_items` where it holds for every holder
// (character, merchant and chest alike) rather than in the chest's caller:
//
//   * `player_items_stack_is_plain_check` -- a stacked row carries no rolled
//     identity. Rarity and item level are per-instance facts and a stack has no
//     single instance to own them; five arrows sharing one "item_level 88" is
//     meaningless, and it is exactly the state in which a partial carry path
//     would look plausible.
//   * `player_item_affixes_host_is_single` -- an AFFIXED row is never a stack.
//     A CHECK cannot see another table, so this is a composite foreign key: the
//     affix row carries a degenerate `host_quantity` column pinned to 1 by its
//     own CHECK, and references `player_items (id, quantity)`. Postgres then
//     enforces both halves declaratively -- an affix cannot be attached to a
//     row whose quantity is not 1, and `player_items.quantity` cannot be moved
//     off 1 while an affix references it (the FK's default ON UPDATE NO ACTION
//     rejects it). `host_quantity` defaults to 1, so no INSERT anywhere in the
//     codebase changes.
//
// Together they make "an item with rolled identity is a single instance" a
// schema fact rather than a convention every future caller has to remember.

exports.up = (pgm) => {
  pgm.addColumns('player_items', {
    // NULL = held by a character or a merchant. Set = this instance is sitting
    // in an account chest slot and belongs to no character at all -- the chest
    // is account-scoped, which is the entire point of the feature
    // (1714440280000): a helmet the Warrior looted can be taken out by the
    // Mage.
    //
    // CASCADE, deliberately: see the header. When the container row goes -- the
    // account was deleted, the item type was deleted -- the instance it was
    // holding goes with it. The alternative is an ownerless row that nothing
    // will ever read again.
    account_item_id: {
      type: 'uuid',
      references: 'account_items',
      onDelete: 'CASCADE',
    },
  });

  // One chest slot holds at most one instance. Partial, so every
  // character-held item costs nothing and NULL never collides with NULL.
  pgm.createIndex('player_items', 'account_item_id', {
    name: 'player_items_account_item_unique',
    unique: true,
    where: 'account_item_id IS NOT NULL',
  });

  // EXACTLY ONE of the three holders, expressed as a count rather than as a
  // chain of `<>`. 484's two-way `(a IS NULL) <> (b IS NULL)` is correct for
  // two and does not generalise: for three columns the analogous XOR chain is
  // true when ALL THREE are non-null, which is precisely the state this
  // forbids. `num_nonnulls` says the invariant literally and stays correct when
  // a fourth holder is added.
  //
  // Replaces `player_items_one_holder_check` rather than standing beside it:
  // two independent CHECKs would each be satisfiable while the pair means
  // something nobody wrote down.
  pgm.dropConstraint('player_items', 'player_items_one_holder_check');
  pgm.addConstraint('player_items', 'player_items_one_holder_check',
    'CHECK (num_nonnulls(character_id, merchant_stock_id, account_item_id) = 1)');

  // A stacked row carries no rolled identity -- see the header. Every existing
  // row has quantity 1 (verified on both the dev and a freshly seeded
  // database), so this cannot reject anything already stored; if a future data
  // set ever violates it the migration fails loudly here rather than admitting
  // a stack of five identical foxy helmets.
  pgm.addConstraint('player_items', 'player_items_stack_is_plain_check',
    "CHECK (quantity = 1 OR (rarity = 'white' AND item_level = 1))");

  // The composite-FK half: an affixed instance is never a stack.
  //
  // `(id, quantity)` is trivially unique because `id` is the primary key. The
  // UNIQUE exists only so a foreign key may reference the pair -- Postgres
  // requires a unique constraint on the referenced columns, and there is no
  // other way to make "the row I point at has quantity 1" a declarative fact.
  pgm.addConstraint('player_items', 'player_items_id_quantity_key',
    { unique: ['id', 'quantity'] });

  pgm.addColumns('player_item_affixes', {
    // Degenerate on purpose: this column is always 1 and is never read by any
    // query. It exists so the foreign key below has a second column to match
    // `player_items.quantity` against. The default is what keeps every existing
    // INSERT (loot.js, chestLoot.js) untouched.
    host_quantity: { type: 'integer', notNull: true, default: 1 },
  });
  pgm.addConstraint('player_item_affixes', 'player_item_affixes_host_quantity_check',
    'CHECK (host_quantity = 1)');
  // Redundant with the existing single-column FK on player_item_id for the
  // DELETE direction, and NOT redundant for the UPDATE direction: this is the
  // constraint that refuses `UPDATE player_items SET quantity = 5` on a row
  // that has affix rows.
  pgm.addConstraint('player_item_affixes', 'player_item_affixes_host_is_single', {
    foreignKeys: {
      columns: ['player_item_id', 'host_quantity'],
      references: 'player_items(id, quantity)',
      onDelete: 'CASCADE',
    },
  });

  // BACKFILL. One instance per pre-existing chest row, carrying the three
  // columns that are all a pre-498 chest row ever held. character_id is NULL
  // and account_item_id names the container, which is exactly what the
  // one-holder CHECK above demands. Runs AFTER the CHECK is in place, so a row
  // this statement got wrong would fail here rather than commit.
  pgm.sql(`
    INSERT INTO player_items (character_id, item_type_id, quantity, soulbound, account_item_id)
    SELECT NULL, ai.item_type_id, ai.quantity, ai.soulbound, ai.id
      FROM account_items ai
     WHERE NOT EXISTS (
       SELECT 1 FROM player_items pi WHERE pi.account_item_id = ai.id
     )
  `);
};

exports.down = (pgm) => {
  // Symmetric with the backfill. `account_items` still carries item_type_id,
  // quantity and soulbound for every stored item -- depositItem keeps writing
  // them precisely so this reversal is exact -- so dropping the held instances
  // reverts the chest to its pre-498 contents with nothing missing that the
  // pre-498 schema could have represented. Rarity, item level and affixes are
  // lost, which is not a defect of this down(): it IS the pre-498 behaviour.
  //
  // First, so the drops below cannot trip over a row that still names a
  // container.
  pgm.sql('DELETE FROM player_items WHERE account_item_id IS NOT NULL');

  pgm.dropConstraint('player_item_affixes', 'player_item_affixes_host_is_single');
  pgm.dropConstraint('player_item_affixes', 'player_item_affixes_host_quantity_check');
  pgm.dropColumns('player_item_affixes', ['host_quantity']);
  pgm.dropConstraint('player_items', 'player_items_id_quantity_key');
  pgm.dropConstraint('player_items', 'player_items_stack_is_plain_check');

  pgm.dropConstraint('player_items', 'player_items_one_holder_check');
  pgm.addConstraint('player_items', 'player_items_one_holder_check',
    'CHECK ((character_id IS NULL) <> (merchant_stock_id IS NULL))');

  pgm.dropIndex('player_items', 'account_item_id', { name: 'player_items_account_item_unique' });
  pgm.dropColumns('player_items', ['account_item_id']);
};
