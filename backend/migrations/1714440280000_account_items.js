exports.shorthands = undefined;

// SOMET-310: the account chest ("bank") -- item storage SHARED BY EVERY
// CHARACTER ON ONE ACCOUNT, reachable from a bank post beside the merchant in
// every village.
//
// THE `user_id` COLUMN IS THE ENTIRE FEATURE. player_items is keyed by
// character_id (1714440092000 re-keyed it there deliberately: an account's
// playthroughs are separate), so there has been no way to move a helmet from
// the Warrior who looted it to the Mage who can actually use it. This table is
// that missing edge, and it is keyed one level up on purpose. users.gold is
// already account-wide, so an account-scoped store is not a new concept here --
// it is the concept gold has always used.
//
// Every other account is excluded by the same column: a deposit/withdraw
// predicate of `user_id = $n` is an authorization check, not a filter, and it
// is the ONLY thing standing between two players' chests. The bank post itself
// is public -- anyone may walk up to it -- exactly like a merchant stall.
//
// THE 40-SLOT CAP IS A SCHEMA INVARIANT, NOT AN APPLICATION COUNT. This is the
// same rule 1714440092000 states for the 8-character cap, and it is stated
// again here because the racy version is the tempting one: a
// `SELECT count(*) ... < 40` guard read by two concurrent deposits on the last
// free slot returns 39 to BOTH, and both insert. `slot smallint CHECK (slot
// BETWEEN 1 AND 40)` plus UNIQUE(user_id, slot) makes a 41st row
// unrepresentable, so the loser of that race takes a constraint violation the
// service turns into "your chest is full" -- a correct refusal instead of a
// silent 41-item chest.
//
// A consequence worth naming: `slot` is an occupancy token, NOT a UI position.
// The service claims the lowest free slot on deposit and the panel renders in
// slot order, so an item withdrawn from the middle leaves a hole that the next
// deposit fills. Nothing in the game lets a player choose a slot, and nothing
// should read `slot` as "where the player put it".
//
// `soulbound` is CARRIED ACROSS THE MOVE rather than cleared. Starting-loadout
// gear is marked soulbound at grant time (1714440174000) and refuses to become
// gold in trade.js's sellItem; if the flag were dropped when an item entered
// the chest, depositing and withdrawing would launder a bound item into a
// sellable one and reopen the SOMET-277 faucet through a brand-new door.
// Storing bound items IS allowed (moving one between your own characters can
// never produce gold, because it stays unsellable wherever it lands) -- what is
// not allowed is losing the flag on the way.
//
// item_type_id + quantity + soulbound, deliberately NOT the player_items row
// id: the instance is deleted from player_items and re-created on withdraw, so
// a stored item has no stable instance identity across the round trip. That
// costs nothing today (no per-instance state survives except these three
// columns) and it is why stones are refused entry by the service -- a
// stone_instances row keys off a player_items id that a stored stone would no
// longer have.
exports.up = (pgm) => {
  pgm.createTable('account_items', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'integer', notNull: true, references: 'users', onDelete: 'CASCADE' },
    slot: { type: 'smallint', notNull: true },
    item_type_id: { type: 'integer', notNull: true, references: 'item_types', onDelete: 'CASCADE' },
    quantity: { type: 'integer', notNull: true, default: 1 },
    soulbound: { type: 'boolean', notNull: true, default: false },
    deposited_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('account_items', 'account_items_slot_check', 'CHECK (slot BETWEEN 1 AND 40)');
  pgm.addConstraint('account_items', 'account_items_quantity_check', 'CHECK (quantity > 0)');
  pgm.addConstraint('account_items', 'account_items_user_slot_unique', { unique: ['user_id', 'slot'] });
  pgm.createIndex('account_items', 'user_id');
};

// Non-lossy for anything but the chests themselves: every stored item is a row
// here and nowhere else, so dropping this table destroys them. That is the
// correct behavior for unwinding a deploy that never should have shipped -- the
// items were only ever reachable through the feature being removed -- but it
// does mean running this against a live server takes real player property with
// it. Same caveat 1714440092000's down() carries, for the same reason.
exports.down = (pgm) => {
  pgm.dropTable('account_items');
};
