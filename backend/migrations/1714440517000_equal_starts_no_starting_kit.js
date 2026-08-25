exports.shorthands = undefined;

// Equal starts: no class is handed a starting kit any more.
//
// THE DECISION (SOMET-509, product owner). Every character begins unarmed and
// identical. All differentiation comes from the passive tree and from gear the
// player finds -- classes start statistically near-identical and diverge
// through the tree. This reverses the direction of SOMET-492/493/503, which
// gave each class a kit and equipped it.
//
// WHAT THIS IS AND IS NOT. It is a DATA change and nothing else. The mechanism
// those tickets built stays exactly where it is:
//
//   * class_loadouts keeps its table, its equip_slot and its
//     socket_into_item_type_id columns and every constraint on them;
//   * grantStartingLoadout keeps both passes, including the socket wiring;
//   * seedOneClassLoadout keeps writing directives ON CONFLICT.
//
// All of it simply has no rows to act on. That is deliberate: if the decision
// is ever revisited, restoring kits is an INSERT, not a re-implementation.
// down() below is that INSERT, and it is exact rather than approximate.
//
// THE OTHER HALF IS THE `unarmed` ROW BELOW. Removing the kits is only safe if
// holding nothing is genuinely worse than holding something, and it was not:
// items.js#DEFAULT_WEAPON_NAME was 'dagger', so a character with empty hands
// swung an 8-damage 0.30s weapon for 26.7 dps at no stamina cost -- the single
// strongest option in the starting band, better than every kit this migration
// deletes. Ship the deletion without the new default and every weapon a player
// finds becomes a downgrade from bare hands.
//
// So `unarmed` is authored here as a real weapon row and
// items.js#DEFAULT_WEAPON_NAME now names it. A catalog row rather than a
// constant in code, for three reasons: it is tunable through the same admin
// screens as every other weapon; its relationship to the rest of the band is
// assertable in SQL rather than by a number copied into a test; and
// resolveDefaultWeaponId keeps meaning exactly what it meant, so every
// fixture-built World in the test suite that supplies its own default weapon is
// untouched by this change.
//
// THE NUMBERS, measured against the live catalog rather than assumed. The floor
// of what a level-1 character can equip is crude-wand at 5 / 0.7 = 7.1 dps,
// then crude-spear 10.0, crude-blade 10.9, iron-wand 11.4, storm staff 13.6.
// (SOMET-509 itself named crude-blade's 10.9 as the floor; that is wrong, and
// sizing against it would have left bare hands beating every wand in the game.)
// unarmed at 3 / 0.6 = 5.0 dps sits at ~70% of the true floor, so every
// authored weapon is a real upgrade with margin.
//
// IT COSTS NOTHING, deliberately. Unarmed is where a player lands when the mana
// is gone, the quiver is empty or the weapon is unequipped -- each of those an
// intended out in the resource economy (see 1714440514000's header). A cost on
// the floor itself would mean a drained player cannot attack at all.
//
// IT SCALES WITH NO STAT, also deliberately. Combat has no unarmed-scaling
// path, and adding one would create an unarmed build the passive tree has no
// nodes for: a whole feature smuggled in behind a fallback. Unarmed is a floor,
// not a playstyle.
//
// REACH 55 and ARC 0.5 are at or under the catalog's own minimums for a melee
// weapon (70 and 0.5), so fists are shorter and no wider than anything on the
// rack, not merely weaker per swing.
//
// VALUE 0 so a stray instance is worth nothing at a merchant. Nothing grants
// one: no class_loadouts row (this migration empties that table), no
// creature_drops or chest_loot entry, and the gear ladder generates its own
// rungs. The dagger stays in the catalog as ordinary droppable gear -- it
// simply stops being handed out for free.
//
// SCOPE: THE CATALOG ONLY. Not one player row is touched. Existing characters
// keep every item they hold and keep it equipped -- SOMET-503's backfill
// already dressed 9 of 10 live characters and taking that back is hostile.
// This changes what NEW characters receive, which is precisely the set of rows
// grantStartingLoadout reads at first join and nothing else. player_items,
// player_equipment and stone_instances are not named anywhere below.
//
// SOMET-335: A MIGRATION ALONE WOULD NOT HOLD. seeds/data/entityTypes.js is the
// second source of truth for these rows and it WINS on a re-seed --
// seedOneClassLoadout re-inserts anything still listed there. So its
// CLASS_LOADOUTS list is emptied in the same commit. Deleting here without
// emptying there buys nothing: the next `node scripts/seed-catalogs.js` puts
// every kit straight back.
exports.up = (pgm) => {
  // The new floor. ON CONFLICT so a database that somehow already carries the
  // name converges on these numbers rather than failing the migration -- the
  // same shape 1714440516000 used for the quarterstaff.
  pgm.sql(`
    INSERT INTO item_types
      (name, category, kind, slot, two_handed, damage, cooldown, reach, arc_width,
       mana_cost, stamina_cost, element, value, req_level, item_level, tier,
       req_strength, req_dexterity, req_constitution, req_intelligence, req_wisdom, req_charisma,
       vfx)
    VALUES
      ('unarmed', 'weapon', 'melee', 'main_hand', false, 3, 0.6, 55, 0.5,
       0, 0, NULL, 0, 1, 1, 1,
       0, 0, 0, 0, 0, 0,
       '{"attack": "slash_light", "impact": "spark_hit", "miss": "generic_whiff"}'::jsonb)
    ON CONFLICT (name) DO UPDATE
      SET category = EXCLUDED.category, kind = EXCLUDED.kind, slot = EXCLUDED.slot,
          two_handed = EXCLUDED.two_handed, damage = EXCLUDED.damage,
          cooldown = EXCLUDED.cooldown, reach = EXCLUDED.reach,
          arc_width = EXCLUDED.arc_width, mana_cost = EXCLUDED.mana_cost,
          stamina_cost = EXCLUDED.stamina_cost, element = EXCLUDED.element,
          value = EXCLUDED.value, req_level = EXCLUDED.req_level,
          item_level = EXCLUDED.item_level, tier = EXCLUDED.tier
  `);

  // Unqualified on purpose. Every class loses its kit, including Ranger --
  // which is no longer playable, so no new character can be rolled into it at
  // all, and the characters already in it keep the gear they were granted.
  pgm.sql('DELETE FROM class_loadouts');
};

// Exactly the 18 rows that existed before this migration ran, restored by NAME
// the way 1714440513000 and 1714440514000 write theirs: a catalog missing one
// of the named rows restores the others rather than failing the whole
// migration, and the tests assert the RESOLVED join so a silent miss goes red
// in CI rather than in play.
//
// Reverting for real also means putting the list back in
// seeds/data/entityTypes.js, or the next re-seed will not know about these.
exports.down = (pgm) => {
  // The `unarmed` row goes first: reverting this decision means the dagger is
  // the default again (items.js#DEFAULT_WEAPON_NAME must be put back with it),
  // and leaving a stray unarmed row behind would keep resolveDefaultWeaponId
  // pointing at it. Guarded on there being no instances of it, because deleting
  // a type someone somehow owns would cascade their row away -- if any exist,
  // the row stays and the operator is left to look at it.
  pgm.sql(`
    DELETE FROM item_types
     WHERE name = 'unarmed'
       AND NOT EXISTS (SELECT 1 FROM player_items pi WHERE pi.item_type_id = item_types.id)
  `);

  pgm.sql(`
    INSERT INTO class_loadouts (entity_type_id, item_type_id, quantity, equip_slot, socket_into_item_type_id)
    SELECT e.id, i.id, k.quantity, k.equip_slot, h.id
      FROM (VALUES
        ('Warrior', 'short sword',               1,  'main_hand', NULL),
        ('Warrior', 'leather-vest',              1,  'chest',     NULL),
        ('Ranger',  'bow',                       1,  'main_hand', NULL),
        ('Ranger',  'arrow',                     20, NULL,        NULL),
        ('Ranger',  'leather-vest',              1,  'chest',     NULL),
        ('Mage',    'apprentice staff',          1,  'main_hand', NULL),
        ('Mage',    'stone_of_apprentice staff', 1,  NULL,        'apprentice staff'),
        ('Mage',    'arcane-ward',               1,  'head',      NULL),
        ('Monk',    'quarterstaff',              1,  'main_hand', NULL),
        ('Monk',    'leather-vest',              1,  'chest',     NULL),
        ('Cultist', 'apprentice staff',          1,  'main_hand', NULL),
        ('Cultist', 'stone_of_apprentice staff', 1,  NULL,        'apprentice staff'),
        ('Cultist', 'leather-vest',              1,  'chest',     NULL),
        ('Archer',  'bow',                       1,  'main_hand', NULL),
        ('Archer',  'arrow',                     20, NULL,        NULL),
        ('Archer',  'leather-vest',              1,  'chest',     NULL),
        ('Druid',   'club',                      1,  'main_hand', NULL),
        ('Druid',   'leather-vest',              1,  'chest',     NULL)
      ) AS k(class, item, quantity, equip_slot, socket_into)
      JOIN entity_types e ON e.name = k.class
      JOIN item_types   i ON i.name = k.item
      LEFT JOIN item_types h ON h.name = k.socket_into
    ON CONFLICT (entity_type_id, item_type_id) DO UPDATE
      SET equip_slot = EXCLUDED.equip_slot,
          socket_into_item_type_id = EXCLUDED.socket_into_item_type_id
  `);
};
