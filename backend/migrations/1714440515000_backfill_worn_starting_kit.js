const { EQUIP_SQL, SOCKET_SQL } = require('../src/services/loadoutBackfill.js');

exports.shorthands = undefined;

// Existing characters wear their starting kit too.
//
// 1714440513000 and 1714440514000 are both NEW-CHARACTERS-ONLY: they change
// what class_loadouts says, and class_loadouts is read exactly once per
// character, by grantStartingLoadout, which claims
// characters.starting_loadout_granted_at once ever. A character that already
// claimed it will never read those rows again, so without this migration every
// character that exists today keeps the empty paper doll and the dagger
// fallback for good. The product owner approved the backfill.
//
// THE SQL LIVES IN src/services/loadoutBackfill.js, NOT HERE. Its guards are
// the entire safety argument for a migration that writes to live player
// property, and a test that re-typed them would be asserting against its own
// copy -- green while the statements that actually ran on players' data said
// something else. One text, executed by this migration and by every skip-case
// test in starting_loadout_worn_by_every_class_db.test.js.
//
// WHAT THE GUARDS ARE FOR, in one place:
//
//   1. THE SLOT MUST BE EMPTY.  A character wearing a looted breastplate must
//      not be stripped back into their starting leather-vest. Nothing here
//      ever replaces an occupied slot -- a NOT EXISTS plus
//      ON CONFLICT (character_id, slot) DO NOTHING, belt and braces, because
//      one of them is the guard and the other is what stops a race turning a
//      lost guard into a thrown migration.
//
//   2. THE CHARACTER MUST STILL HOLD THE INSTANCE.  Since SOMET-484/498 a
//      player_items row is held by exactly one of a character, a merchant's
//      shelf or the account chest -- the num_nonnulls(...) = 1 CHECK on the
//      table enforces it. So `pi.character_id = c.id` IS the "still holds"
//      test: an item sold to a merchant has merchant_stock_id set and
//      character_id NULL, an item in the bank has account_item_id set and
//      character_id NULL, and neither can match. Nothing in either statement
//      UPDATEs player_items.character_id, by design -- pulling a banked item
//      onto the paper doll is not a backfill, it is a withdrawal the player
//      did not ask for.
//
//   3. THE INSTANCE MUST BE SOULBOUND.  This is what makes "the starting kit"
//      precise rather than "any item of that type". grantStartingLoadout is
//      the only writer of soulbound = true, and a soulbound item can be
//      neither sold nor dropped -- so a held soulbound short sword IS the one
//      this character was granted. Without this guard a Warrior who sold the
//      starting sword and bought a better one would have the BOUGHT sword
//      silently equipped by a migration.
//
//   4. THE INSTANCE MUST NOT ALREADY BE EQUIPPED ELSEWHERE.
//      player_equipment carries a UNIQUE constraint on item_id, so equipping
//      an already-worn instance into a second slot is not a wrong row, it is
//      a thrown migration.
//
//   5. THE ITEM MUST BE FREELY WEARABLE.  SOMET-478 gates equipping on
//      req_level and the six req_* stats, and this writes player_equipment
//      directly, below canEquip. Every item in every current class kit is
//      req_level 1 with all six requirements at 0 -- asserted by a test rather
//      than assumed here -- so the guard is a no-op today. It is here so that
//      the day a kit gains a stat-gated item the backfill SKIPS it, rather
//      than building a paper doll the player could not legally assemble and
//      the client would refuse to restore after any unequip.
//
//   6. THE CHARACTER MUST HAVE CLAIMED ITS LOADOUT.  A character with
//      starting_loadout_granted_at IS NULL has been handed nothing yet and
//      gets the fully-worn version from grantStartingLoadout on its first
//      join. Guard 3 would already exclude it, but stating it keeps the
//      population this migration addresses legible in the query rather than
//      implied by a side effect.
//
// WHAT IS DELIBERATELY *NOT* GUARDED. A character at their carry cap gains one
// row from the socket pass and ends up one over. That is not damage:
// capacityOf/hasFreeSlot gate FUTURE pickups only, nothing is destroyed, and
// the same character created today receives that same stone as part of its
// kit. Refusing the stone to a full backpack would instead leave exactly the
// class-inert Mage this whole item exists to fix.
exports.up = (pgm) => {
  pgm.sql(EQUIP_SQL);
  pgm.sql(SOCKET_SQL);
};

// A DOCUMENTED NO-OP, on the same reasoning 1714440167000 and 1714440513000
// both spell out: this migration's only writes are to player property, and
// undoing them would be strictly destructive rather than symmetrical.
//
// Un-equipping would rip gear off characters who have since played whole
// sessions with it -- and could not tell a slot this migration filled from one
// the player filled afterwards. Deleting the granted stones would destroy
// stone_instances rows that accrue XP and levels from the moment they land, so
// a rolled-back-then-re-applied deploy would silently reset a player's stone
// progress to level 1.
//
// A rollback therefore leaves existing characters dressed while
// 1714440514000's own down() puts future ones back to bare. That asymmetry is
// recoverable -- re-running the two migrations restores the intent, and up() is
// written to be safely re-runnable: every guard re-reads the state it guards,
// so a second run finds every slot filled and every host socketed and writes
// nothing. Destroyed player property is not recoverable.
exports.down = () => {};
