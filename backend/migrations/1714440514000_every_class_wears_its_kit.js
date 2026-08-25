exports.shorthands = undefined;

// Every class wears its starting kit, not just the Cultist.
//
// WHAT 1714440513000 LEFT ON THE TABLE. That migration built the mechanism --
// class_loadouts.equip_slot and class_loadouts.socket_into_item_type_id, acted
// on by grantStartingLoadout's second pass -- and then deliberately pointed it
// at ONE class, because dressing the other five is a balance decision rather
// than a bug fix. Its own words: "The MECHANISM here is general so that
// decision is later a data change; the CONTENT is one class."
//
// The product owner has now made that decision: every class's starting kit is
// worn. This is that data change. No code moves; grantStartingLoadout already
// does everything below, it was simply never told to.
//
// THE NUMBERS, MEASURED (not guessed) on a scratch database through a real
// createCharacter + websocket join + world.activeWeapon, before and after:
//
//   class    before (dagger fallback)     after
//   -------  ---------------------------  ------------------------------------
//   Warrior  8 dmg / 0.30 cd / 0 stam     short sword 11 / 0.45 / 6 stam
//   Druid    8 dmg / 0.30 cd / 0 stam     club        10 / 0.45 / 6 stam
//   Archer   8 dmg / 0.30 cd / 0 stam     bow         12 / 0.60 / 8 stam, ammo
//   Monk     8 dmg / 0.30 cd / 0 stam     stick        7 / 0.35 / 0 stam
//   Mage     8 dmg / 0.30 cd / 0 mana     staff+stone 10 / 0.55 / 8 mana arcane
//   Cultist  staff+stone 10 / 0.55 / 5 hp unchanged weapon, + chest armour
//
// TWO OF THOSE ROWS NEED SAYING OUT LOUD.
//
// 1. THE MONK GETS WEAKER. The stick is 7 damage on a 0.35s cooldown; the
//    dagger fallback it replaces is 8 on 0.30s -- 20.0 dps against 26.7, a
//    25% cut. This migration does NOT quietly substitute a better weapon to
//    hide that: the stick IS the Monk's authored starting kit, and the whole
//    point of the change is that a class now fights with what it was handed.
//    If the Monk's kit is wrong, the fix is the Monk's kit, in
//    seeds/data/entityTypes.js, not a special case here.
//
// 2. THE MAGE NEEDS A STONE, exactly as the Cultist did. activeWeaponType
//    zeroes a BARE magic weapon (nonzero mana_cost or non-physical element)
//    down to physical damage at the dagger's baseline -- so an equipped but
//    unsocketed apprentice staff would give the Mage 8 physical damage on a
//    0.55s cooldown, which is strictly worse than the dagger it replaced AND
//    leaves the class's own passive start node ("+3 arcane damage",
//    start-intelligence) permanently inert, because the Mage would never deal
//    arcane damage at all. So the Mage's staff gets the same
//    stone_of_apprentice staff the Cultist's does. That stone is the one
//    1714440167000 generated FROM this staff, so its spell is the staff's own
//    original spell -- not a balance point invented here.
//
//    The Mage's cost picture after this: 8 mana per cast out of a 150 pool at
//    0.5 mana/s regen, i.e. 18 casts and then roughly one cast per 16s. That
//    is the game's ordinary magic economy (any player socketing a stone by
//    hand meets it), it is the same shape the Cultist shipped with, and a
//    mana-dry Mage can still unequip the staff and fall back to the dagger.
//    It is a real constraint and it is reported as one.
//
// The Archer's bow consumes arrows, and the Archer's kit already contains
// arrow x20 (checked, not assumed -- see class_loadouts). Ammo is spent from
// the BAG; no slot holds it, so nothing here needs to equip it. A bow with an
// empty quiver refuses the shot (`noammo`) rather than firing for free, and
// the Archer's out is the same as the Mage's: unequip and swing the dagger.
//
// WHY DRIVEN OFF item_types.slot RATHER THAN A HAND-WRITTEN LIST. Every
// wearable in the catalog already declares the slot it belongs in, and
// canEquip refuses any armour whose `type.slot` disagrees with the requested
// slot. Copying those answers into a literal list here would be a second
// source of truth for the same fact, free to drift the day a kit changes; the
// UPDATE below simply asks the catalog. Weapons all declare 'main_hand', and
// the addColumns CHECK from 1714440513000 still refuses anything outside the
// slot vocabulary, so a catalog row with a nonsense slot fails loudly.
//
// Rows carrying a socket directive are skipped: 1714440513000's
// worn-XOR-socketed CHECK forbids a row being both, and a stone is inside a
// weapon rather than on the paper doll.
//
// SCOPE: NEW CHARACTERS ONLY. Existing characters are backfilled by
// 1714440515000, separately and with its own guards, because that one touches
// live player property and this one does not.
exports.up = (pgm) => {
  pgm.sql(`
    UPDATE class_loadouts cl
       SET equip_slot = it.slot
      FROM item_types it
     WHERE it.id = cl.item_type_id
       AND cl.socket_into_item_type_id IS NULL
       AND it.category IN ('weapon', 'armor')
       AND it.slot IS NOT NULL
  `);

  // The Mage's spell stone. Same cross-join-on-names shape as
  // 1714440513000's Cultist row: a database missing either catalog row
  // inserts nothing rather than failing the migration, and the tests assert
  // the RESOLVED join so a silent miss goes red in CI rather than in play.
  pgm.sql(`
    INSERT INTO class_loadouts (entity_type_id, item_type_id, quantity, socket_into_item_type_id)
    SELECT e.id, s.id, 1, w.id
      FROM entity_types e, item_types s, item_types w
     WHERE e.name = 'Mage'
       AND s.name = 'stone_of_apprentice staff' AND s.category = 'stone'
       AND w.name = 'apprentice staff'          AND w.category = 'weapon'
    ON CONFLICT (entity_type_id, item_type_id) DO NOTHING
  `);
};

// Back to 1714440513000's state: the Cultist's staff stays worn and its stone
// row stays, everything else goes back to NULL, and the Mage's stone row is
// removed. Like 1714440513000's own down() this touches the CATALOG only --
// characters already granted keep whatever they were given, because
// un-granting property a player may have levelled, unsocketed or built around
// is the destructive asymmetry that migration documents at length.
exports.down = (pgm) => {
  pgm.sql(`
    UPDATE class_loadouts SET equip_slot = NULL
     WHERE equip_slot IS NOT NULL
       AND NOT (entity_type_id = (SELECT id FROM entity_types WHERE name = 'Cultist')
                AND item_type_id = (SELECT id FROM item_types WHERE name = 'apprentice staff'))
  `);
  pgm.sql(`
    DELETE FROM class_loadouts
     WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Mage')
       AND item_type_id IN (SELECT id FROM item_types WHERE name = 'stone_of_apprentice staff')
  `);
};
