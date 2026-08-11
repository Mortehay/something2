exports.shorthands = undefined;

// Existing magic weapons predate the socket system (Task 1,
// 1714440165000/1714440166000): their spell was baked directly into
// item_types.element/mana_cost/damage/cooldown. This migration converts
// every such weapon TYPE into a corresponding stone type, then gives every
// player who owns one of those weapons a matching stone instance,
// pre-socketed into their weapon. Modeled on 1714440092000_characters.js: a
// real, reversible rewrite of data players already own.
//
// weaponDamage()/applyAttackCooldown() in src/authority/world.js (read in
// full, not just grepped) are the ONLY places a weapon's spell-relevant
// fields are read off `w` at the attack sites: w.damage and w.element in
// weaponDamage (line 50-53), w.cooldown in applyAttackCooldown (line 59-61),
// and w.mana_cost gating/spending the cast (lines 357, 378). Those four
// columns -- element, mana_cost, damage, cooldown -- are the complete "spell"
// a stone must carry. knockback/stamina_cost/reach/arc_width/range/etc. are
// melee/projectile WEAPON mechanics, not spell mechanics, and stay on the
// weapon type untouched.
//
// The weapon's own element/mana_cost/damage/cooldown columns are left
// untouched -- once combat integration (a later task) ships, they become
// vestigial (combat reads the socketed stone instead), but leaving them
// intact means down() needs no data reconstruction on the weapon-type side.
//
// MULTI-INSTANCE-OWNERSHIP RISK (flagged in the plan; resolved here, not
// skipped). A naive design pairs each newly-created stone back to "the"
// weapon player_items row it came from by re-joining on
// (character_id, item_type_id) after the fact -- that join is only
// 1:1-correct if a character never owns two instances of the exact same
// magic weapon type. Queried the live dev DB before writing this SQL:
//
//   SELECT pi.character_id, pi.item_type_id, count(*)
//     FROM player_items pi JOIN item_types wt ON wt.id = pi.item_type_id
//    WHERE wt.category = 'weapon' AND wt.element IS NOT NULL AND wt.element <> 'physical'
//    GROUP BY 1,2 HAVING count(*) > 1
//
// -> ZERO rows. Only one magic weapon is currently owned at all (one
// 'apprentice staff', qty 1). So a plain join happens to be safe against
// TODAY's snapshot -- but that is a fact about dev data on 2026-08-11, not a
// guarantee about whatever production looks like when this migration
// actually runs. Rather than lean on a point-in-time count for a migration
// that rewrites real player-owned data, `targets` below generates the
// stone's player_items id ONCE PER WEAPON-INSTANCE ROW and threads that
// exact id through both the new player_items row and the stone_instances
// row in the same statement. The pairing is therefore exact by
// construction -- one weapon_pi row in, one stone id out, no re-join, no
// assumption about instance counts -- and stays correct even if a character
// owns 1, 2, or N instances of the same magic weapon type. Proven with a
// DB-backed test that gives one character TWO instances of the same magic
// weapon type and asserts each gets its own distinct, correctly-socketed
// stone (see migration_convert_magic_weapons_db.test.js).
//
// IDEMPOTENCY SCOPE: per the task interface, only the catalog-row creation
// (the first statement) is idempotent (ON CONFLICT (name) DO NOTHING) --
// safe to repeat in a repair scenario. The player-instance conversion
// (second statement) is NOT idempotent: re-running up() after a successful
// run will insert a second stone for every already-converted weapon
// instance and then hit stone_instances_socketed_into_unique (Task 1's
// one-stone-per-host partial unique index) on the SECOND stone competing
// for the same already-occupied weapon slot, aborting the whole statement
// loudly. That is the intended, safer failure mode -- a silent duplicate
// stone is worse than a migration that refuses to double-run.
exports.up = (pgm) => {
  // 1. One stone item_type per distinct magic weapon type. Named
  // deterministically from the weapon so a repair-run ON CONFLICT is safe.
  pgm.sql(`
    INSERT INTO item_types (name, category, element, mana_cost, damage, cooldown, stackable)
    SELECT 'stone_of_' || wt.name, 'stone', wt.element, wt.mana_cost, wt.damage, 0, false
      FROM item_types wt
     WHERE wt.category = 'weapon' AND wt.element IS NOT NULL AND wt.element <> 'physical'
    ON CONFLICT (name) DO NOTHING
  `);

  // 2. One stone player_items row + stone_instances row, pre-socketed, for
  // every player_items row of a converted weapon type. `targets` is
  // MATERIALIZED (forced, not left to the planner's referenced-more-than-once
  // default) so gen_random_uuid() is evaluated exactly once per weapon
  // instance and that same id is reused by both INSERTs below -- this is
  // what makes the stone-to-weapon pairing exact regardless of duplicate
  // ownership (see the design note above).
  pgm.sql(`
    WITH targets AS MATERIALIZED (
      SELECT pi.id AS weapon_player_item_id, pi.character_id, st.id AS stone_type_id,
             gen_random_uuid() AS stone_player_item_id
        FROM player_items pi
        JOIN item_types wt ON wt.id = pi.item_type_id
        JOIN item_types st ON st.name = 'stone_of_' || wt.name
       WHERE wt.category = 'weapon' AND wt.element IS NOT NULL AND wt.element <> 'physical'
    ),
    ins_items AS (
      INSERT INTO player_items (id, character_id, item_type_id, quantity)
      SELECT stone_player_item_id, character_id, stone_type_id, 1
        FROM targets
      RETURNING id
    )
    INSERT INTO stone_instances (player_item_id, socketed_into_id)
    SELECT stone_player_item_id, weapon_player_item_id
      FROM targets
  `);
};

exports.down = (pgm) => {
  // stone_instances rows cascade away with their player_items row
  // (stone_instances.player_item_id ON DELETE CASCADE, 1714440166000), so
  // deleting the stone player_items rows is enough to unwind step 2. The
  // weapon's own player_items row and item_types columns were never touched
  // by up(), so there is nothing to reconstruct on that side.
  pgm.sql(`
    DELETE FROM player_items
     WHERE item_type_id IN (
       SELECT id FROM item_types WHERE category = 'stone' AND name LIKE 'stone_of_%'
     )
  `);
  pgm.sql(`DELETE FROM item_types WHERE category = 'stone' AND name LIKE 'stone_of_%'`);
};
