exports.shorthands = undefined;

// F-013 (P0): grantStartingLoadout (src/authority/items.js) used to be gated
// on "this account currently owns zero items" (SELECT ... FROM player_items
// LIMIT 1) — a state a player can walk back into at will. Sell the starter
// dagger+vest to a village merchant, or drop them, then reconnect: the join
// handler (server.js) sees an empty inventory and grants a FRESH set with
// new instance ids. Confirmed live, twice, on a clean account (0 -> 21 -> 42
// gold via repeated sell+reconnect; a pure +2-items-per-reconnect via
// drop+reconnect+re-pickup within the drop's TTL is the same root cause).
//
// The grant must happen once per ACCOUNT, ever — recorded as a fact about
// the account, not re-derived from current item ownership on every join.
exports.up = async (pgm) => {
  pgm.addColumns('users', {
    starting_loadout_granted_at: { type: 'timestamptz', notNull: false, default: null },
  });

  // Backfill decision: stamp now() for every existing account. This code has
  // been live for a while, so every existing account has already received
  // (or has had, and since spent/dropped) its starting loadout — treating
  // them as "already granted" means nobody gets a surprise SECOND loadout
  // the moment this deploys. The cost is explicit: a genuinely destitute
  // existing player (one who sold or dropped everything before this fix
  // landed) will NOT be automatically re-kitted by this migration or by the
  // join path afterward. Re-kitting a destitute player is an explicit,
  // rate-limited product action if it's ever wanted — not something this
  // migration, or grantStartingLoadout, should do silently.
  pgm.sql('UPDATE users SET starting_loadout_granted_at = now() WHERE starting_loadout_granted_at IS NULL');
};

exports.down = (pgm) => {
  pgm.dropColumns('users', ['starting_loadout_granted_at']);
};
