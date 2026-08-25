exports.shorthands = undefined;

// SOMET-492 -- a fresh Cultist pays nothing to cast.
//
// WHAT THE TICKET SAID, AND WHY IT IS NOT THE WHOLE STORY.
//
// The ticket blames one thing: since 1714440167000, activeWeaponType
// (src/authority/items.js) neutralises a BARE weapon's mana_cost to 0, and the
// Cultist's starting loadout is an unsocketed apprentice staff -- so its
// life-cost identity never engages. That is true, and it is only the second
// half. Reproduced on a scratch database against the real
// createCharacter + grantStartingLoadout + activeWeaponType path:
//
//   Cultist   inventory: apprentice staff x1, leather-vest x1
//             equipment: {}
//             active weapon: DAGGER, mana_cost 0, damage 8
//
// -- and identically for Warrior, Mage, Monk, Druid and Archer. The starting
// loadout is granted into the BAG and never worn: grantStartingLoadout writes
// player_items rows and nothing else, no client sends an equip frame on join,
// and activeWeaponType therefore falls through to its DEFAULT_WEAPON_NAME
// ('dagger') fallback for every freshly rolled character of every class.
//
// So the ticket's own option 1 -- "give the Cultist a spell stone in its
// starting loadout" -- would have been INERT: a stone sitting loose in the
// backpack is not socketed into anything, and the staff it would have to be
// socketed into is not equipped either. Three things have to be true at once
// before a Cultist pays for its first cast: the staff is EQUIPPED, a spell
// stone is SOCKETED into it, and the stone carries a mana_cost.
//
// WHY NOT REMOVE THE ZEROING INSTEAD (the ticket's option 2, and the obvious
// one-line "fix"). The zeroing is load-bearing and was itself a fix: without
// it an unsocketed magic weapon hits with its full spell damage at zero cost
// (SOMET-245's "Important #3"), which is a permanent un-costed power buff on
// every magic weapon a player can obtain after the one-time conversion
// migration ran -- merchant stock, creature drops, chest loot. Note it does
// NOT touch ordinary melee: the branch is entered only by a weapon with a
// nonzero mana_cost or a non-physical element, so short sword / club / stick /
// dagger never reach it. But every staff in the catalog does, so deleting the
// zeroing would rebalance the entire magic-weapon catalog to fix one class's
// opening minute. Rejected.
//
// WHAT THIS MIGRATION DOES. It makes class_loadouts describe not just WHAT a
// class is handed but HOW IT IS WORN, with two nullable columns:
//
//   equip_slot                -- equip this granted instance into that slot
//   socket_into_item_type_id  -- socket this granted stone into the granted
//                                instance of that item type
//
// Both default to NULL, and a NULL pair reproduces today's behaviour exactly.
// Only the Cultist's two rows are given directives below, so no other class's
// loadout, damage, stamina cost or mana cost moves by a single point. That is
// deliberate and narrow: auto-equipping every class's starting weapon would
// take a Warrior from the dagger's 8 damage / 0 stamina to the short sword's
// 11 / 6 and hand the Archer an ammo-consuming bow, which is a game-wide
// balance decision for the product owner, not a bug fix. The MECHANISM here is
// general so that decision is later a data change; the CONTENT is one class.
//
// The Cultist's numbers after this migration, worked out by hand from the
// catalog rows (apprentice staff mana_cost 8, so stone_of_apprentice staff
// mana_cost 8 -- the conversion migration copies the column):
//
//   lifeCostFor(8, 0.9) = ceil(8 * 0.6 * 0.9) = ceil(4.32) = 5 hp per cast
//
// 0.9 is the Cultist tree start node's lifeCostMultiplier. 5 hp out of a
// 110 hp pool, at the staff's 0.55s cooldown, is ~9 hp/s against a 1 hp/s
// regen -- the class's identity is legible from the first shot, and
// canPayLife refuses the cast that would drop it below 1 hp (spec 8.3: a
// Cultist is stopped by its own cost, never killed by it).
//
// SCOPE: NEW CHARACTERS ONLY, DELIBERATELY. This does not backfill Cultists
// that already claimed their loadout -- grantStartingLoadout is once-ever per
// character and this migration does not touch player state. The ticket is
// about "what the player is handed at character creation" in its own words,
// and a backfill would have to decide what to do with a character who has
// since sold, dropped or replaced that staff, or already equipped something
// better into main_hand. An existing Cultist reaches the same place by
// socketing any spell stone into any magic weapon, which is the ordinary
// route the class always had. If pre-existing Cultists should be repaired too,
// that is a separate, player-data-touching decision.
exports.up = (pgm) => {
  pgm.addColumns('class_loadouts', {
    equip_slot: { type: 'text' },
    socket_into_item_type_id: {
      type: 'integer',
      references: 'item_types',
      onDelete: 'CASCADE',
    },
  });

  // The slot vocabulary is items.js's SLOTS, spelled out rather than
  // referenced: a typo in seed data must be refused by the database at write
  // time, not discovered as a paper-doll entry no client can render.
  pgm.addConstraint('class_loadouts', 'class_loadouts_equip_slot_check',
    `CHECK (equip_slot IS NULL OR equip_slot IN
      ('main_hand','off_hand','head','chest','hands','feet','ring1','ring2'))`);

  // A row is worn OR socketed, never both -- a stone socketed into a weapon is
  // inside that weapon, not on the paper doll, and a row asking for both would
  // leave grantStartingLoadout to pick one silently.
  pgm.addConstraint('class_loadouts', 'class_loadouts_worn_xor_socketed_check',
    'CHECK (equip_slot IS NULL OR socket_into_item_type_id IS NULL)');

  // The Cultist's staff is worn.
  pgm.sql(`
    UPDATE class_loadouts SET equip_slot = 'main_hand'
     WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Cultist')
       AND item_type_id   = (SELECT id FROM item_types   WHERE name = 'apprentice staff')
  `);

  // ...and its spell stone rides inside it. The stone type is the one
  // 1714440167000 generated from the apprentice staff itself, so its
  // element/mana_cost/damage/cooldown ARE the staff's own original spell --
  // this grants the Cultist the staff it always looked like it had, not a new
  // balance point invented here.
  //
  // Cross-joined on names in the shape 1714440510000 and seed-catalogs.js both
  // use: a database missing either row inserts nothing rather than failing the
  // migration. six_classes_db.test.js-style tests assert the RESOLVED join, so
  // a silent miss is caught by a test rather than by a player.
  pgm.sql(`
    INSERT INTO class_loadouts (entity_type_id, item_type_id, quantity, socket_into_item_type_id)
    SELECT e.id, s.id, 1, w.id
      FROM entity_types e, item_types s, item_types w
     WHERE e.name = 'Cultist'
       AND s.name = 'stone_of_apprentice staff' AND s.category = 'stone'
       AND w.name = 'apprentice staff'          AND w.category = 'weapon'
    ON CONFLICT (entity_type_id, item_type_id) DO NOTHING
  `);
};

// Drops the directives and the stone row. Characters already granted keep the
// equipment and stone_instances rows they were given -- this migration does not
// reach into player state, and un-granting a stone a player may already have
// unsocketed, sold or levelled is exactly the destructive asymmetry
// 1714440167000's own down() is documented as. A rolled-back deploy leaves
// existing Cultists armed and future ones bare, which is recoverable; deleting
// player property is not.
exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM class_loadouts
     WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Cultist')
       AND item_type_id IN (SELECT id FROM item_types WHERE name = 'stone_of_apprentice staff')
  `);
  pgm.dropConstraint('class_loadouts', 'class_loadouts_worn_xor_socketed_check');
  pgm.dropConstraint('class_loadouts', 'class_loadouts_equip_slot_check');
  pgm.dropColumns('class_loadouts', ['equip_slot', 'socket_into_item_type_id']);
};
