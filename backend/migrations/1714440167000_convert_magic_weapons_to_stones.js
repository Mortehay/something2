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
// NAME-COLLISION RISK (review finding, fixed here). `targets` joins on
// `st.name = 'stone_of_' || wt.name` -- WITHOUT also requiring
// `st.category = 'stone'`, that join matches ANY item_types row that
// happens to already carry that name, stone or not. Combined with statement
// 1's `ON CONFLICT (name) DO NOTHING` (which silently no-ops if a
// same-named row of ANY category already exists, rather than only a real
// stone), a pre-existing unrelated row named e.g. 'stone_of_flame staff'
// (category='consumable', from some other seed/admin action) would have
// caused `targets` to pair that weapon's owners with the DECOY row instead
// of a real stone -- granting a bogus item and creating a stone_instances
// row pointing at a player_items row that isn't even a stone. Reproduced
// and confirmed by code review before this fix; the corrected join below
// requires `st.category = 'stone'`, so a name collision with a non-stone
// row now means that weapon type is silently skipped (no bogus grant, no
// error) rather than silently corrupted -- the same "fail safe, not
// silent-corrupt" posture as the multi-instance fix above. down() already
// filtered on `category = 'stone'` (see below), so up() and down() now
// agree on exactly which rows count as "a stone this migration created".
//
// IDEMPOTENCY SCOPE (review finding: the original claim here was WRONG,
// corrected). Statement 1 (catalog rows) is genuinely idempotent via
// `ON CONFLICT (name) DO NOTHING`. Statement 2 now also skips any weapon
// instance that currently has ANY stone socketed into it (see the
// `NOT EXISTS` guard below) -- so an immediate re-run, before any stone has
// ever been unsocketed, is a safe no-op instead of erroring on
// stone_instances_socketed_into_unique. THIS GUARD DOES NOT COVER
// UNSOCKETING. Once a converted stone is removed from its weapon (a stated
// goal of this whole epic -- sockets are meant to be reusable), the weapon
// row satisfies `NOT EXISTS` again indistinguishably from "never
// converted", and a second up() WILL grant it a second, duplicate stone.
// There is no durable marker in this data model that survives an unsocket
// and records "this weapon already received its one-time conversion grant"
// -- adding one would mean a schema change, out of scope for this data-only
// migration. Practical consequence: this migration must be treated as a
// genuine one-time operation once the socket system is live and players can
// unsocket stones -- do not re-run it after that point.
exports.up = (pgm) => {
  // 1. One stone item_type per distinct magic weapon type. Named
  // deterministically from the weapon so a repair-run ON CONFLICT is safe.
  pgm.sql(`
    INSERT INTO item_types (name, category, element, mana_cost, damage, cooldown, stackable)
    SELECT 'stone_of_' || wt.name, 'stone', wt.element, wt.mana_cost, wt.damage, wt.cooldown, false
      FROM item_types wt
     WHERE wt.category = 'weapon' AND wt.element IS NOT NULL AND wt.element <> 'physical'
    ON CONFLICT (name) DO NOTHING
  `);

  // 2. One stone player_items row + stone_instances row, pre-socketed, for
  // every player_items row of a converted weapon type that doesn't already
  // have a stone socketed into it. `targets` is MATERIALIZED (forced, not
  // left to the planner's referenced-more-than-once default) so
  // gen_random_uuid() is evaluated exactly once per weapon instance and
  // that same id is reused by both INSERTs below -- this is what makes the
  // stone-to-weapon pairing exact regardless of duplicate ownership (see
  // the design note above). The `st.category = 'stone'` predicate closes
  // the name-collision risk above; the `NOT EXISTS` predicate is the
  // partial re-run guard described above.
  pgm.sql(`
    WITH targets AS MATERIALIZED (
      SELECT pi.id AS weapon_player_item_id, pi.character_id, st.id AS stone_type_id,
             gen_random_uuid() AS stone_player_item_id
        FROM player_items pi
        JOIN item_types wt ON wt.id = pi.item_type_id
        JOIN item_types st ON st.name = 'stone_of_' || wt.name AND st.category = 'stone'
       WHERE wt.category = 'weapon' AND wt.element IS NOT NULL AND wt.element <> 'physical'
         AND NOT EXISTS (SELECT 1 FROM stone_instances si WHERE si.socketed_into_id = pi.id)
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
  // LOSSY BY DESIGN FOR ANY STONE ACQUIRED AFTER up() RAN, NOT JUST THE ONES
  // up() ITSELF CREATED (review finding). This deletes EVERY player_items
  // row whose item_type is a 'stone_of_%' catalog row, and then deletes
  // those catalog rows outright -- it has no way to distinguish "a stone
  // this migration granted" from "a stone of the exact same type a player
  // later legitimately dropped, crafted, traded for, or bought from a
  // merchant" once the socket system is live, because nothing marks a
  // player_items row with which migration run created it. Running this
  // down() against a database where players have acquired 'stone_of_%'
  // items through ordinary gameplay DESTROYS that real, legitimately-owned
  // property, not just the migration's own backfill.
  //
  // Deleting the item_types rows is ALSO destructive beyond player
  // inventories: any catalog table that references a stone_of_% item_type
  // with ON DELETE CASCADE (behavior_drops, chest_loot, creature_drops,
  // merchant_stock, class_loadouts, as of this writing) loses its rows for
  // that item silently along with it -- e.g. a chest or merchant stock
  // slot configured to award a converted stone would have its config
  // erased, not just left dangling.
  //
  // This is acceptable ONLY the same way 1714440092000_characters.js's down()
  // is acceptable: as a rollback of a bad deploy on a database that has NOT
  // yet grown the state this asymmetry would destroy (i.e. immediately after
  // up() runs, before any player has touched a stone). It is NOT a
  // general-purpose rollback and must not be run against a live server where
  // players have been playing with sockets.
  //
  // Uses starts_with(), not `LIKE 'stone_of_%'`: LIKE's `_` is itself a
  // single-character wildcard, so an unescaped `LIKE 'stone_of_%'` matches
  // more than the literal prefix (e.g. 'stoneXofX...'). starts_with() is an
  // exact prefix test with no wildcard semantics to get wrong.
  pgm.sql(`
    DELETE FROM player_items
     WHERE item_type_id IN (
       SELECT id FROM item_types WHERE category = 'stone' AND starts_with(name, 'stone_of_')
     )
  `);
  pgm.sql(`DELETE FROM item_types WHERE category = 'stone' AND starts_with(name, 'stone_of_')`);
};
