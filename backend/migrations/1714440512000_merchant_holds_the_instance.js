/* eslint-disable camelcase */
exports.shorthands = undefined;

// SOMET-484. Selling an affixed item to a village merchant and buying it back
// returned a plain white base item: `merchant_stock` keys on `item_type_id`
// alone, so `sellItem` DELETEd the `player_items` row (cascading its
// `player_item_affixes` rows away with it) and `buyStock` INSERTed a brand new
// instance built from the catalog type. Rarity, item level and every rolled
// affix were destroyed by the round trip.
//
// WHY A REFERENCE AND NOT A SNAPSHOT.
//
// `world_items` (T12, migration 1714440507000) solved the identical problem by
// denormalising the instance onto the ground row -- rarity, item_level, an
// `affixes` jsonb array and soulbound. That trade is defensible THERE and only
// there, and its own header says why: the row's maximum lifetime is 180
// seconds and nothing else joins to it. A merchant buyback row lives for
// BUYBACK_DAYS (three days), and the affix catalog is editable by admin CRUD
// (`PUT`/`DELETE /api/affix-types` in index.js) the whole time. A jsonb
// snapshot carries a bare `affixTypeId` integer with no foreign key, so:
//
//   - `player_item_affixes.affix_type_id` is deliberately ON DELETE RESTRICT
//     so that deleting a catalog affix cannot silently strip a stat off gear
//     players are holding. A snapshot on `merchant_stock` has no FK at all and
//     would route straight around that protection: the admin DELETE would
//     succeed while three days of merchant stock still named the dead affix,
//     and every buyback would then hydrate an affix whose `key` and `effect`
//     are NULL -- live in the database, inert in play.
//   - An edit to an affix's `effect` between the sale and the buyback changes
//     what the snapshot MEANS without changing the snapshot.
//
// So the merchant HOLDS the instance instead of copying it. Selling moves the
// `player_items` row from the character to the merchant; buying moves it back.
// The rarity, the item level and the affix rows are never read, never written
// and never copied, so there is no carry path that can be incomplete: the
// round trip is lossless by construction rather than by careful copying.
//
// WHY THE POINTER LIVES ON `player_items`, NOT ON `merchant_stock`.
//
// The obvious shape is `merchant_stock.player_item_id`. It is the wrong
// direction, for two reasons that both come down to cleanup:
//
//   1. A merchant_stock row is deleted from four places (the lazy expiry
//      sweep in fetchShop, repriceBaseCatalog's value<=0 delete, buyStock's
//      consume, and the village/world CASCADEs). With the pointer on
//      merchant_stock, each of those would have to remember to delete the
//      held instance too, or leave a `player_items` row owned by nobody,
//      forever, invisible to every query in the codebase. That is four places
//      to get right and no constraint that notices when one is missed.
//      With `player_items.merchant_stock_id ... ON DELETE CASCADE`, all four
//      clean themselves up and no future deleter has to know this exists.
//   2. "An instance has exactly one holder" becomes a table-level CHECK on
//      `player_items` (below) instead of an invariant spread across two
//      tables that nothing can express.
//
// `character_id` therefore loses its NOT NULL -- but it is not weakened: the
// CHECK below is strictly stronger than the NOT NULL it replaces, because it
// forbids BOTH holders being absent AND both being present.

exports.up = (pgm) => {
  pgm.addColumns('player_items', {
    // NULL = held by a character (the ordinary case, and every pre-existing
    // row). Set = this instance is sitting in a merchant's buyback shelf and
    // belongs to no character at all.
    //
    // CASCADE, deliberately: see the header. When the buyback row goes -- it
    // expired, the village was deleted, the item type was deleted -- the
    // instance it was holding goes with it. The player was paid for it three
    // days ago; the alternative is an ownerless row that nothing will ever
    // read again.
    merchant_stock_id: {
      type: 'uuid',
      references: 'merchant_stock',
      onDelete: 'CASCADE',
    },
  });

  // A merchant_stock row is one specific instance (quantity is CHECKed > 1
  // away) so at most one player_items row may name it. Partial, so the
  // overwhelming majority of rows -- every character-held item -- costs
  // nothing and NULL never collides with NULL.
  pgm.createIndex('player_items', 'merchant_stock_id', {
    name: 'player_items_merchant_stock_unique',
    unique: true,
    where: 'merchant_stock_id IS NOT NULL',
  });

  // Every pre-existing row has character_id NOT NULL and merchant_stock_id
  // NULL, so it satisfies the CHECK; the DROP NOT NULL therefore cannot admit
  // anything the CHECK does not immediately re-forbid. Order matters: add the
  // CHECK first so there is no instant at which an ownerless row is legal.
  pgm.addConstraint('player_items', 'player_items_one_holder_check',
    'CHECK ((character_id IS NULL) <> (merchant_stock_id IS NULL))');
  pgm.alterColumn('player_items', 'character_id', { notNull: false });

  // NOT ENFORCED IN SQL, deliberately, and here is the invariant it would
  // enforce: a BASE-CATALOG row (seller_user_id IS NULL) is infinite stock
  // conjured from the item type, so it must never hold an instance -- if one
  // ever did, buyStock would hand out that one physical item and then go on
  // selling it forever. A CHECK cannot see across the two tables and a
  // composite FK cannot reference a partial unique index, so the alternative
  // is a trigger. It is not worth one: `merchant_stock_id` has exactly one
  // writer (sellItem), which always sets it to the row insertBuyback just
  // created with a non-NULL seller_user_id, and the two functions that create
  // base-catalog rows (seedBaseCatalog, seedItemAcrossVillages) never touch
  // player_items at all. `a base-catalog buy still mints a fresh white
  // instance` in merchant_buyback_instance_db.test.js is what pins it.
};

exports.down = (pgm) => {
  // Instances held by a merchant have no character to return to -- the seller
  // was paid and the character may since have been deleted. Drop them; the
  // buyback rows themselves survive and revert to the pre-484 behaviour of
  // rebuilding a white base item from the type.
  pgm.sql('DELETE FROM player_items WHERE merchant_stock_id IS NOT NULL');
  pgm.alterColumn('player_items', 'character_id', { notNull: true });
  pgm.dropConstraint('player_items', 'player_items_one_holder_check');
  pgm.dropIndex('player_items', 'merchant_stock_id', { name: 'player_items_merchant_stock_unique' });
  pgm.dropColumns('player_items', ['merchant_stock_id']);
};
