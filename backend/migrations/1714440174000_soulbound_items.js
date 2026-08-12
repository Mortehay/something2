exports.shorthands = undefined;

// SOMET-277 (P0): unbounded gold faucet via character churn.
//
// The starting loadout is granted once per CHARACTER
// (characters.starting_loadout_granted_at, 1714440092000 + items.js's
// conditional claim). Gold, however, is per ACCOUNT (users.gold). So the
// per-character flag -- which correctly closed the ORIGINAL sell-then-
// reconnect exploit (F-013 / 1714440035000) -- does nothing against:
//
//   create Warrior -> join -> sell the granted short sword (32) + leather
//   vest (16) to a village merchant for +24 gold -> DELETE the character ->
//   create another Warrior -> repeat, forever.
//
// deleteCharacter has no cooldown and createCharacter refills the slot
// immediately; MAX_CHARACTERS = 8 bounds concurrency, not rate. The flag is
// destroyed along with the character, the gold is not.
//
// The fix is to make the granted INSTANCES bound to the character: they can
// be equipped and used, but never converted back into account-wide gold.
// Marked per INSTANCE, not per item TYPE: zeroing item_types.value (or
// refusing to sell item type 10 at all) would also make every short sword
// ever looted from a creature or bought from a merchant worthless. This
// column is precisely the difference between "granted to you at creation"
// and "the same kind of item, acquired legitimately".
//
// Named for the RULE rather than the provenance ("granted_at_creation")
// because the guards that read it -- trade.js sellItem, loot.js dropItem --
// enforce a policy, and a future second source of bound items (a quest
// reward, a tutorial gift) should reuse this column rather than add a second
// one and an OR chain at every guard. grantStartingLoadout is its only
// writer today.
//
// BACKFILL: DELIBERATELY NONE. Every existing player_items row keeps the
// column default (false) and therefore stays sellable.
//
// Rows already granted cannot be told apart from looted/bought ones after
// the fact. The only available signal is a timestamp heuristic
// (player_items.created_at close to characters.starting_loadout_granted_at,
// item_type_id in that character's class_loadouts), and it does not hold up:
// checked against the live dev database, the granted rows land 1-20ms AFTER
// the flag and differ from each other (they predate items.js's transactional
// grant, so now() was not a shared transaction timestamp), and at least one
// character has a matching-type row created two DAYS later. Any tolerance
// window wide enough to catch the real grants is a guess, and a false
// positive permanently confiscates an item a player legitimately owns
// (unsellable AND undroppable, with no in-game way to undo it), while a
// false negative costs at most 24 gold, once, for that character.
//
// Stated plainly, because it is a real residue and not a rounding error:
// characters that ALREADY hold their starting loadout when this deploys can
// still sell it and be deleted, once each, for the same +24. What this
// closes is the UNBOUNDED part -- every character created from now on gets
// bound gear, so the loop stops being repeatable. The leftover is a one-off
// bounded by the number of pre-existing characters that still hold an
// unsold loadout, and can be swept by an admin UPDATE against a
// hand-verified id list if it is ever judged worth the risk of getting one
// wrong.
exports.up = (pgm) => {
  pgm.addColumns('player_items', {
    soulbound: { type: 'boolean', notNull: true, default: false },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('player_items', ['soulbound']);
};
