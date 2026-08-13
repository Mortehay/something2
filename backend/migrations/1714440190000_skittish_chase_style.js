exports.shorthands = undefined;

// The first non-aggressive creature behaviour in the game (SOMET-290).
//
// Every chase style before this one acquires a player and closes. `skittish`
// backs away instead, and only fights once it has been damaged or cornered --
// which is what makes a starting-zone pen a place to practise rather than a
// place to die.
//
// The CHECK is widened rather than replaced piecewise because a CHECK is one
// value: services/creatureBehaviors.js carries the same list in JS, and that
// duplication is deliberate and documented there -- a value rejected only in
// JS reaches the database, and a value rejected only in SQL reaches the sim
// from a row written before the constraint existed.
//
// The row is split across TWO inserts, not one. Migration
// 1714440084000_drop_behavior_attack_columns (SOMET-253) moved the attack
// fields (attack_kind/attack_range/attack_cooldown/projectile_speed/
// projectile_radius) out of creature_behaviors and into creature_abilities,
// one row per attack, keyed on (behavior_id, slot). seeds/data/
// creatureBehaviors.js still carries those keys as flat object fields
// because scripts/seed-catalogs.js SPLITS a row across both tables when it
// re-applies the catalog -- a raw SQL INSERT has no such split step, so
// copying that file's shape verbatim into one INSERT here fails with
// "column does not exist". The slot-1 ability row is not optional even
// though it looks like plumbing: DEFAULT_ABILITY in
// services/creatureBehaviors.js is the fallback for a behaviour with NO
// ability rows, and it carries attack_cooldown 1.0, not this profile's 1.2
// -- omitting the ability row would make a freshly-seeded Skittish (which
// gets the ability from seeds/data/creatureAbilities.js) and a
// migration-only Skittish (which would fall back to DEFAULT_ABILITY)
// disagree on cooldown, silently.
exports.up = (pgm) => {
  pgm.dropConstraint('creature_behaviors', 'creature_behaviors_chase_style_check');
  pgm.addConstraint('creature_behaviors', 'creature_behaviors_chase_style_check',
    "CHECK (chase_style IN ('charge','kite','skirmish','hold','ambush','guard','skittish'))");

  // Byte-for-byte the row in seeds/data/creatureBehaviors.js (the movement
  // half). The seed file makes a fresh database work; this makes the live
  // one work without a re-seed. Same arrangement tile_types uses.
  //
  // preferred_range IS the flee radius for this style -- 0 would be a
  // creature that never backs away, i.e. the behaviour silently inert.
  //
  // aura_*/gold_min/gold_max other than the two gold columns are left at
  // their table defaults (0/1/1/1), matching the seed file, which also
  // omits them for this row.
  pgm.sql(`
    INSERT INTO creature_behaviors
      (name, aggro_radius, leash_radius, chase_style, preferred_range, move_speed_mult, gold_min, gold_max)
    VALUES
      ('Skittish', 300, 500, 'skittish', 150, 1.15, 0, 2)
    ON CONFLICT (name) DO NOTHING
  `);

  // The attack half, byte-for-byte the slot-1 row in
  // seeds/data/creatureAbilities.js. projectile_speed/projectile_radius/
  // damage_mult/knockback are left at their table defaults (0/0/1/0), which
  // are exactly right for a plain melee hit.
  pgm.sql(`
    INSERT INTO creature_abilities
      (behavior_id, slot, name, attack_kind, attack_range, attack_cooldown)
    SELECT id, 1, 'Nip', 'melee', 60, 1.2 FROM creature_behaviors WHERE name = 'Skittish'
    ON CONFLICT (behavior_id, slot) DO NOTHING
  `);
};

exports.down = (pgm) => {
  // Release this behaviour's referents BEFORE deleting it. entity_types
  // .behavior_id references creature_behaviors with NO ACTION
  // (1714440081000_entity_behavior.js), so a bare DELETE raises an FK
  // violation the moment any entity_type still points at 'Skittish'.
  //
  // In the ordered rollback this is a no-op: 1714440191000's own down runs
  // first and resets the three types it flagged. But that down knows exactly
  // three hardcoded names, and this profile is meant to be adopted more
  // widely -- SOMET-289's pens will pick from it. The first type flagged by
  // anything other than that one migration would wedge the rollback HERE,
  // after dropConstraint below has already run, leaving the schema
  // half-reverted. Releasing by behavior_id rather than by name costs
  // nothing in the ordered case and is the difference between a working and
  // a wedged rollback in every other.
  //
  // 'Line' is the reset target because it is already this schema's fallback
  // profile: 1714440081000's own comment states that a creature type with no
  // behavior_id resolves to Line in services/creatureBehaviors.js. Pointing a
  // released type at it therefore lands it exactly where an unflagged type
  // sits -- a plain charger -- rather than at a dangling null or at whichever
  // profile it happened to carry before.
  pgm.sql(`
    UPDATE entity_types SET behavior_id = (SELECT id FROM creature_behaviors WHERE name = 'Line')
    WHERE behavior_id = (SELECT id FROM creature_behaviors WHERE name = 'Skittish')
  `);
  // The behaviour row goes next: the narrowed CHECK below would reject it
  // while it still carries chase_style 'skittish'. Its slot-1 ability row
  // does not need a matching DELETE -- creature_abilities.behavior_id is
  // ON DELETE CASCADE (1714440083000_creature_abilities.js), so deleting
  // the behaviour removes the ability with it.
  pgm.sql("DELETE FROM creature_behaviors WHERE name = 'Skittish'");
  pgm.dropConstraint('creature_behaviors', 'creature_behaviors_chase_style_check');
  pgm.addConstraint('creature_behaviors', 'creature_behaviors_chase_style_check',
    "CHECK (chase_style IN ('charge','kite','skirmish','hold','ambush','guard'))");
};
