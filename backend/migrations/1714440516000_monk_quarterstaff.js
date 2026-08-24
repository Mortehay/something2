exports.shorthands = undefined;

// The Monk gets a weapon that fits it: the quarterstaff (SOMET-504).
//
// WHAT 1714440514000 LEFT BEHIND, IN ITS OWN WORDS. That migration dressed
// every class in its authored kit and reported, without smoothing it over,
// that ONE row went backwards: "THE MONK GETS WEAKER. The stick is 7 damage on
// a 0.35s cooldown; the dagger fallback it replaces is 8 on 0.30s -- 20.0 dps
// against 26.7, a 25% cut. [...] If the Monk's kit is wrong, the fix is the
// Monk's kit, in seeds/data/entityTypes.js, not a special case here."
//
// The product owner has now decided the Monk's kit IS wrong, and chose a new
// weapon over re-tuning the stick. This is that change. No code moves; the
// SOMET-503 mechanism (class_loadouts.equip_slot, acted on by
// grantStartingLoadout's second pass) already does everything below.
//
// ---------------------------------------------------------------------------
// WHY A NEW ROW AND NOT AN EXISTING ONE
// ---------------------------------------------------------------------------
//
// The brief says to prefer a catalog weapon over inventing one. The catalog
// was checked, in full, and nothing fits. Every weapon in the starting price
// band (value <= 60), by dps:
//
//   dagger 26.7 | short sword 24.4 | knife 24.0 | mid club 23.3 | long sword
//   23.1 | pike 22.4 | morning star 22.7 | club 22.2 | two-handed sword 22.0 |
//   archmage staff 21.8 | frost staff 21.4 | scythe 21.1 | bow 20.0 | halberd
//   20.0 | magic-bolt 20.0 | flame staff 20.0 | stick 20.0 | darts 20.0 |
//   apprentice staff 18.2 | arbalest 16.7 | sling 16.0 | storm staff 13.6
//
// THE DAGGER IS THE ONLY ITEM IN THE BAND THAT CLEARS THE DAGGER. The gear
// ladder's tier-1 rung is far below all of it (crude-blade 10.9, crude-spear
// 10.0, crude-wand 7.1). So there is no existing row that both clears the bar
// the brief sets and reads as a wisdom-keyed martial artist's weapon, and a
// new row is the only honest option. See the header of the test file for what
// that fact says about the dagger, which is a bigger question than this one.
//
// ---------------------------------------------------------------------------
// THE WEAPON, AND EVERY NUMBER IN IT
// ---------------------------------------------------------------------------
//
//   quarterstaff -- melee, main_hand, one-handed
//   damage 7 | cooldown 0.25 | reach 110 | arc_width 0.7
//   stamina_cost 0 | mana_cost 0 | element NULL | value 28
//   req_level 1, all six req_* = 0
//
// DAMAGE 7, DELIBERATELY UNCHANGED FROM THE STICK. The Monk keeps the lowest
// per-hit damage of any class weapon (Warrior 11, Archer 12, Druid 10, Mage
// 10, Monk 7). The stick's 7 was never the problem and it is not what moved.
//
// COOLDOWN 0.25 IS WHAT MOVED, from 0.35. That is the fastest swing in the
// entire catalog (tied with `knife`), and it is the whole design: a martial
// artist does not hit harder, a martial artist hits MORE. 7 / 0.25 = 28.0 dps
// against the dagger fallback's 8 / 0.30 = 26.7 -- clear by 5%, which is the
// smallest margin that satisfies the brief. The margin is deliberately thin;
// see "WHAT THIS DOES TO THE OTHER FIVE" below for why it is not thicker.
//
// IT IS NOT A STRICT UPGRADE ON THE DAGGER, AND THAT IS THE POINT. applyDamage
// mitigates by FLAT SUBTRACTION per hit (`raw2 = raw - defense`,
// authority/damage.js), so a light fast weapon is taxed once per swing and a
// heavy slow one is taxed once per much slower swing. Against a 3-defense
// target the quarterstaff does (7-3)/0.25 = 16.0 dps and the dagger does
// (8-3)/0.30 = 16.7 -- the dagger WINS. The Monk is the best starting weapon
// against soft targets and the worst against armoured ones. That is a real
// trade-off rather than a free buff, and the test file pins both ends of it.
//
// REACH 110, ARC 0.7. A staff out-reaches a short sword (100) and the stick it
// replaces (90), and falls short of a long sword (140) -- reach is the second
// thing the weapon is actually buying. arc_width stays at the stick's own 0.7,
// narrower than the short sword's 0.9 and the club's 0.8: a staff strike is a
// focused line, not a sweep, so the Monk is the weakest melee class against a
// group. Together with the flat-mitigation tax above, those are the two axes
// the Monk pays its dps lead back on.
//
// ONE-HANDED, though a quarterstaff is canonically a two-hander. canEquip
// refuses a two-handed weapon's off hand, and `focus` -- the gear ladder's one
// WISDOM-gated off_hand family, authored in seeds/data/gearLadder.js precisely
// so "a Monk (wisdom) and a Druid (charisma) must both have gear their own
// stat unlocks" -- would then be unreachable for the Monk from level 1 with
// its own starting weapon on. Locking the wisdom class out of the wisdom
// off-hand to win a flavour point is a bad trade. The stick was one-handed too.
//
// ---------------------------------------------------------------------------
// NO STONE IS NEEDED. THE MAGE PRECEDENT WAS CHECKED, NOT ASSUMED.
// ---------------------------------------------------------------------------
//
// 1714440514000 had to hand the Mage a stone because activeWeaponType
// (authority/items.js) zeroes a BARE magic weapon down to the dagger's damage:
//
//     if (type.mana_cost || (type.element != null && type.element !== 'physical'))
//
// The quarterstaff has mana_cost 0 (falsy) and element NULL, so that branch is
// not entered and the function returns the weapon's own row unchanged. This is
// exactly WHY the weapon is authored as plain physical with no mana cost, and
// the test file asserts the resolved damage/cooldown off the running sim
// rather than off this row, so a future edit that gives the quarterstaff an
// element or a mana cost collapses it to 8 physical and goes red immediately.
//
// ---------------------------------------------------------------------------
// WHY IT COSTS NOTHING. THE "ONLY FREE CLASS" PREMISE IS FALSE.
// ---------------------------------------------------------------------------
//
// The brief asks whether the Monk paying nothing is the imbalance. It is not,
// because the Monk is not the only class that attacks for free:
// activeWeaponType's last line is `return itemTypes.get(defaultWeaponId)`,
// with NO ownership check, so ANY character with an empty main hand swings the
// dagger at 8 / 0.30 / free. Free attacks are the game's floor, available to
// all six classes at all times by pressing unequip.
//
// That makes a stamina cost on this weapon unenforceable rather than
// balancing: a Monk charged 4 stamina a swing simply takes the staff off and
// out-damages it bare-handed, and the quarterstaff becomes strictly worse than
// no weapon at all -- which is precisely the bug SOMET-503 shipped and this
// migration exists to undo. A cost the player opts out of with one keypress is
// not a cost.
//
// AND IT CANNOT KEY OFF WISDOM WITHOUT NEW COMBAT CODE. Wisdom's only
// mechanical effect in the game today is mana regeneration
// (playerStats.js: `MANA_REGEN_BASE + MANA_REGEN_PER_WIS * above('wisdom')`)
// plus equip requirements; NO stat scales weapon damage anywhere. A
// mana-costing "ki strike" would route the Monk's identity through the one
// wisdom mechanism that exists, but the arithmetic kills it: a 0.25s cooldown
// at even 5 mana is 20 mana/s against a 110 pool and 11/s regen, i.e. dry in
// six seconds. Mana in this game is a burst resource for a 0.55s caster, not a
// sustain resource for a basic attack. Stamina is the resource shaped for
// sustained melee and it is opt-out-able as shown above. So: no resource.
//
// req_wisdom is likewise left at 0, with the other five. Every other starting
// item is freely wearable; the gear ladder sets tier-1 stat_req to 0 "so a
// brand-new character can equip the whole bottom rung"; and
// services/loadoutBackfill.js encodes `req_level = 1 AND all six req_* = 0` as
// its definition of an item a starting kit may wear. A req_wisdom of 12 would
// class-lock the row (only the Monk starts above 10) and put it outside that
// definition, and this codebase gates gear by level-appropriate stat, never by
// class.
//
// ---------------------------------------------------------------------------
// WHAT THIS DOES TO THE OTHER FIVE, STATED PLAINLY
// ---------------------------------------------------------------------------
//
// It makes the Monk the highest-dps starting class: 28.0 against the Warrior's
// 24.4. That is NOT a judgement that the Monk should out-damage the Warrior.
// It is forced. The brief requires the Monk to clear the dagger fallback, and
// the dagger fallback already out-damages all five other kits -- so ANY weapon
// satisfying the brief tops the table. The real finding is that the free
// fallback is mistuned above every authored kit (worse still on sustain, where
// stamina regen throttles the Warrior to 18.3 dps and the free dagger stays at
// 26.7). Retuning the dagger, not the Monk, is the change that fixes the
// class table; it is out of scope here and is reported as the headline.
//
// ---------------------------------------------------------------------------
// NO BACKFILL. THERE ARE NO MONKS.
// ---------------------------------------------------------------------------
//
// 1714440515000 backfilled the characters that predated SOMET-503. Nothing
// equivalent is needed here, for two independent reasons:
//
//   1. `SELECT count(*) FROM characters c JOIN entity_types e ON e.id =
//      c.entity_type_id WHERE e.name = 'Monk'` returns 0 on the live database.
//      There is no one to backfill.
//   2. It could not be the same kind of backfill even if there were. 1714440515000
//      only EQUIPS an instance the character already holds; an existing Monk
//      holds a `stick`, not a `quarterstaff`, so dressing them would mean
//      GRANTING new property -- a materially more invasive act than wearing
//      what you were already given, and one that hands a second main_hand
//      weapon to a character who may have built around the first.
//
// An existing Monk, if one appeared, keeps its stick, equipped, exactly as
// 1714440515000 left it. Only Monks created from here on get the quarterstaff.
//
// ---------------------------------------------------------------------------
// THE SECOND SOURCE OF TRUTH
// ---------------------------------------------------------------------------
//
// seeds/data/entityTypes.js CLASS_LOADOUTS carries the same two rows and wins
// on a re-seed (playable_classes_db.test.js deletes and re-seeds them).
// seedOneClassLoadout already writes equip_slot ON CONFLICT as well as on
// INSERT (SOMET-335), so the directive survives; what it does NOT do is remove
// a row that has left the list, which is why the stick row is DELETED here
// rather than left to rot. Two main_hand directives on one class would race in
// grantStartingLoadout's `ORDER BY id ASC` second pass, whose INSERT is ON
// CONFLICT DO NOTHING -- the OLDER row (the stick) would win and the whole
// change would ship live and inert. The test asserts the weapon the Monk
// actually joins holding, which is what catches that.
exports.up = (pgm) => {
  // The weapon. ON CONFLICT (name) DO UPDATE rather than DO NOTHING: a
  // database that somehow already has a `quarterstaff` row must end up with
  // THESE numbers, not with whatever it had -- otherwise the migration reports
  // success while the Monk swings something else entirely.
  //
  // vfx IS NOT OPTIONAL HERE, though the column is nullable and 150 gear-ladder
  // rows leave it null. It is the STICK'S OWN vfx, copied exactly. Every one of
  // the other five classes' starting weapons carries one, and this row is swung
  // several times a second by every new Monk from their first fight: without
  // it the attack draws no arc, the hit draws no spark and a miss draws no
  // whiff, so the weapon works mechanically and looks broken -- a first
  // impression of the class that no test asserting damage would ever catch.
  // slash_light/spark_hit/generic_whiff is what `stick`, `dagger` and `club`
  // all use, i.e. the fast-light-melee set this weapon belongs to; every name
  // is a real row in vfx_effects (checked, not assumed).
  pgm.sql(`
    INSERT INTO item_types
      (name, category, kind, slot, two_handed, damage, cooldown, reach, arc_width,
       mana_cost, stamina_cost, element, value, req_level, item_level, tier,
       req_strength, req_dexterity, req_constitution, req_intelligence, req_wisdom, req_charisma,
       vfx)
    VALUES
      ('quarterstaff', 'weapon', 'melee', 'main_hand', false, 7, 0.25, 110, 0.7,
       0, 0, NULL, 28, 1, 1, 1,
       0, 0, 0, 0, 0, 0,
       '{"attack": "slash_light", "impact": "spark_hit", "miss": "generic_whiff"}'::jsonb)
    ON CONFLICT (name) DO UPDATE
      SET category = EXCLUDED.category, kind = EXCLUDED.kind, slot = EXCLUDED.slot,
          two_handed = EXCLUDED.two_handed, damage = EXCLUDED.damage,
          cooldown = EXCLUDED.cooldown, reach = EXCLUDED.reach,
          arc_width = EXCLUDED.arc_width, mana_cost = EXCLUDED.mana_cost,
          stamina_cost = EXCLUDED.stamina_cost, element = EXCLUDED.element,
          value = EXCLUDED.value, req_level = EXCLUDED.req_level,
          vfx = EXCLUDED.vfx
  `);

  // Out with the stick. Scoped to the Monk's row by both ids -- `stick` is an
  // ordinary catalog item that anything else may legitimately list.
  pgm.sql(`
    DELETE FROM class_loadouts
     WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Monk')
       AND item_type_id   = (SELECT id FROM item_types   WHERE name = 'stick')
  `);

  // In with the quarterstaff, WORN. Same cross-join-on-names shape as
  // 1714440513000's and 1714440514000's own rows: a database missing either
  // catalog row inserts nothing rather than failing the migration, and the
  // tests assert the RESOLVED join through a real character so a silent miss
  // goes red in CI rather than in play.
  //
  // DO UPDATE, not DO NOTHING, for the same reason as the catalog row above:
  // a pre-existing row for this pair must end up WORN.
  pgm.sql(`
    INSERT INTO class_loadouts (entity_type_id, item_type_id, quantity, equip_slot)
    SELECT e.id, w.id, 1, 'main_hand'
      FROM entity_types e, item_types w
     WHERE e.name = 'Monk'
       AND w.name = 'quarterstaff' AND w.category = 'weapon'
    ON CONFLICT (entity_type_id, item_type_id) DO UPDATE
      SET equip_slot = EXCLUDED.equip_slot,
          socket_into_item_type_id = NULL
  `);
};

// Back to 1714440514000's state: the Monk wears its stick again.
//
// Unlike 1714440513000's and 1714440514000's down(), this one CAN drop the
// catalog row it added -- but only if nothing references it. That guard is not
// decoration: TEN columns across account_items, behavior_drops, chest_loot,
// class_loadouts (twice), creature_drops, item_types.ammo_type_id,
// merchant_stock, player_items and world_items carry foreign keys to
// item_types, and a Monk created while this migration was up owns a
// quarterstaff instance. Deleting the type out from under a live player's item
// is the destructive asymmetry 1714440513000's header warns about at length.
//
// THE GUARD CANNOT BE A CAUGHT foreign_key_violation, WHICH IS WHAT THIS
// MIGRATION TRIED FIRST AND WHAT MEASURING IT DISPROVED. Nine of those ten
// columns -- INCLUDING player_items.item_type_id -- are ON DELETE CASCADE
// (only item_types.ammo_type_id is RESTRICT). A bare DELETE therefore raises
// nothing at all: it silently CASCADES a live player's quarterstaff instances
// out of existence and reports success. That was verified on a scratch
// database, not reasoned about -- the first version of this down() deleted a
// referenced row and printed its own "leaving the catalog row in place"
// notice while doing it.
//
// So the guard is an explicit NOT EXISTS over the four tables that hold PLAYER
// PROPERTY, which is the thing that must not be destroyed:
//
//   player_items    -- in a character's bag or on their paper doll
//   account_items   -- in the account chest
//   merchant_stock  -- sold to a village merchant (SOMET-156 buyback)
//   world_items     -- dropped on the ground
//
// The other six columns are CATALOG CONTENT (class_loadouts, creature_drops,
// chest_loot, behavior_drops), and cascading those is exactly what should
// happen to a weapon that is being un-shipped. The FK check is KEPT as well,
// as a second line for the RESTRICT case and for any future referencing table,
// but it is no longer load-bearing on its own.
//
// If any player anywhere owns one, the row is LEFT IN PLACE -- harmless, since
// the DELETE above has already taken it off every loadout -- and the rollback
// still succeeds.
exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM class_loadouts
     WHERE entity_type_id = (SELECT id FROM entity_types WHERE name = 'Monk')
       AND item_type_id   = (SELECT id FROM item_types   WHERE name = 'quarterstaff')
  `);

  pgm.sql(`
    INSERT INTO class_loadouts (entity_type_id, item_type_id, quantity, equip_slot)
    SELECT e.id, w.id, 1, 'main_hand'
      FROM entity_types e, item_types w
     WHERE e.name = 'Monk'
       AND w.name = 'stick' AND w.category = 'weapon'
    ON CONFLICT (entity_type_id, item_type_id) DO UPDATE
      SET equip_slot = EXCLUDED.equip_slot,
          socket_into_item_type_id = NULL
  `);

  pgm.sql(`
    DO $$
    BEGIN
      DELETE FROM item_types it
       WHERE it.name = 'quarterstaff'
         AND NOT EXISTS (SELECT 1 FROM player_items   p WHERE p.item_type_id = it.id)
         AND NOT EXISTS (SELECT 1 FROM account_items  a WHERE a.item_type_id = it.id)
         AND NOT EXISTS (SELECT 1 FROM merchant_stock m WHERE m.item_type_id = it.id)
         AND NOT EXISTS (SELECT 1 FROM world_items    w WHERE w.item_type_id = it.id);
      IF EXISTS (SELECT 1 FROM item_types WHERE name = 'quarterstaff') THEN
        RAISE NOTICE 'quarterstaff is still owned by a player somewhere; leaving the catalog row in place';
      END IF;
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE NOTICE 'quarterstaff is still referenced by a RESTRICT constraint; leaving the catalog row in place';
    END $$;
  `);
};
