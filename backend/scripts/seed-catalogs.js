#!/usr/bin/env node
// Upsert the tile / biome / decoration / creature catalogs. Run via
// `make seed-catalogs`.
//
// UPSERT BY NAME, NEVER DELETE. The admin UI is the intended way to author
// catalog entries; the seed files are a floor, not a replacement. A run of this
// script must never cost an admin a tile they added by hand.
const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const { DEFAULT_TILE_TYPES } = require('../seeds/data/tileTypes.js');
const { STARTER_BIOMES } = require('../seeds/data/biomes.js');
const { NEW_DECORATIONS } = require('../seeds/data/decorationTypes.js');
const {
  HOSTILE_CREATURES, CREATURE_DROPS, PLAYABLE_CLASSES, CLASS_LOADOUTS,
} = require('../seeds/data/entityTypes.js');
const { BESTIARY_P4_CREATURES, BESTIARY_P4_DROPS } = require('../seeds/data/bestiaryP4.js');
const { CREATURE_BEHAVIORS } = require('../seeds/data/creatureBehaviors.js');
const { CREATURE_ABILITIES } = require('../seeds/data/creatureAbilities.js');
const { BEHAVIOR_DROPS } = require('../seeds/data/behaviorDrops.js');
const { CHEST_LOOT } = require('../seeds/data/chestLoot.js');

// COALESCE, not plain EXCLUDED, for the four columns below.
//
// A seed entry that OMITS a field passes NULL and COALESCE keeps whatever the
// row already holds; a seed entry that SPECIFIES one overwrites. New tiles (no
// existing row) fall to the column defaults via the same COALESCE.
//
// PROMPTS ARE NOW ALWAYS SPECIFIED, and that is a deliberate reversal.
//
// This comment used to say the opposite: the eleven original terrain prompts
// ("lush green meadow grass" and friends) lived only in the database, authored
// in the admin UI, and DEFAULT_TILE_TYPES omitted them precisely so a re-seed
// could not wipe them. That protected them, but it also meant the seeder could
// not FIX them -- and they needed fixing, because a bare subject with no camera
// or style wording generates an image the renderer cannot use (see the prompt
// notes in seeds/data/tileTypes.js).
//
// So every one of the 50 entries now carries a prompt, which makes this file
// authoritative for prompts and means `make seed-catalogs` OVERWRITES any
// prompt edited in the admin UI. A prompt worth keeping belongs in
// seeds/data/tileTypes.js, not only in the database. This is the one column
// where that trade was made on purpose; the other three still preserve.
async function seedOneTile(db, t) {
  await db.query(
    `INSERT INTO tile_types (name, color, walkable, speed, image, valid_neighbors,
                             prompt, render_mode, wall_height, place_order)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,
             COALESCE($7, ''), COALESCE($8, 'color'), COALESCE($9, 0), COALESCE($10, 0))
     ON CONFLICT (name) DO UPDATE
       SET color = EXCLUDED.color, walkable = EXCLUDED.walkable,
           speed = EXCLUDED.speed, valid_neighbors = EXCLUDED.valid_neighbors,
           prompt = COALESCE($7, tile_types.prompt),
           render_mode = COALESCE($8, tile_types.render_mode),
           wall_height = COALESCE($9, tile_types.wall_height),
           place_order = COALESCE($10, tile_types.place_order)`,
    [t.name, t.color, t.walkable, t.speed, t.image ?? '',
     JSON.stringify(t.valid_neighbors ?? []),
     t.prompt ?? null, t.render_mode ?? null,
     t.wall_height ?? null, t.place_order ?? null],
  );
}

// CASE, not plain EXCLUDED, for creature_types -- for the same reason the four
// tile columns above are COALESCE'd, and it is the one biome column that needs
// it.
//
// P3's 27 new biomes ship `creature_types: []` on purpose: the catalog holds
// only four creatures, so authoring the intended fauna now would seed 27
// dangling references. P4 fills them. Meanwhile the Biomes admin UI is a
// first-class authoring surface for that field, so an unconditional
// `creature_types = EXCLUDED.creature_types` would revert an admin's
// hand-authored fauna to [] on the very next `make seed-catalogs` -- exactly
// what this file's header rule forbids, and it would silently re-create the
// empty-worlds state the user has accepted only as a temporary condition.
//
// So: a seed entry supplying a NON-EMPTY list still wins (the original five
// stay authoritative, and P4's edits will land normally); a seed entry
// supplying an EMPTY one keeps whatever the row already holds. The other nine
// columns are populated on every entry, and `biomes` has exactly these ten
// columns, so there is no column-omission hazard here of the kind the tile
// path had -- as long as every column in the table is actually listed below.
//
// path_tile (SOMET-349 follow-up) is COALESCE-guarded rather than written
// unconditionally, for the same reason the tile columns are: it is an
// admin-authorable field, and a seed entry that omits it must keep whatever
// the row holds instead of resetting a hand-picked road tile to NULL. NULL is
// a meaningful value here -- mapService.roadTileAt reads it as "fall back to
// the world's ambient path tile" -- so "omitted" and "deliberately cleared"
// have to stay distinguishable, and clearing one is the admin UI's job.
//
// Split out of seedCatalogs, mirroring seedOneTile, so the preservation rule
// can be tested against the REAL statement rather than a restatement of it.
async function seedOneBiome(db, b) {
  await db.query(
    `INSERT INTO biomes (name, terrain_tiles, flora_types, creature_types, palette, art_style, exclusions, color, creature_density, path_tile)
     VALUES ($1,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10)
     ON CONFLICT (name) DO UPDATE
       SET terrain_tiles = EXCLUDED.terrain_tiles, flora_types = EXCLUDED.flora_types,
           creature_types = CASE
             WHEN jsonb_array_length(EXCLUDED.creature_types) = 0 THEN biomes.creature_types
             ELSE EXCLUDED.creature_types END,
           palette = EXCLUDED.palette,
           art_style = EXCLUDED.art_style, exclusions = EXCLUDED.exclusions,
           color = EXCLUDED.color, creature_density = EXCLUDED.creature_density,
           path_tile = COALESCE($10, biomes.path_tile)`,
    [b.name, JSON.stringify(b.terrain_tiles ?? []), JSON.stringify(b.flora_types ?? []),
     JSON.stringify(b.creature_types ?? []), JSON.stringify(b.palette ?? []),
     b.art_style, b.exclusions, b.color, b.creature_density ?? 1, b.path_tile ?? null],
  );
}

// COALESCE for every optional field, same rule as seedOneTile: a seed entry
// that OMITS a field must not clobber what an admin tuned in the UI. The
// non-optional two (name, chase_style) are the profile's identity and are
// always written.
//
// The eleven COALESCE-guarded columns split into two groups against the
// twelve rows in seeds/data/creatureBehaviors.js as they stand today:
//   - aggro_radius, leash_radius, preferred_range, move_speed_mult are
//     supplied by all twelve rows. The COALESCE here is nominal insurance
//     for a future row that omits one -- against the current data it never
//     falls back, so it has not yet had occasion to protect a hand-tuned
//     admin value for these four.
//   - damage_override, aura_radius, aura_damage_mult, aura_defense_mult,
//     aura_speed_mult, gold_min, gold_max are genuinely exercised: NO row
//     sets damage_override any more (all twelve fall back to whatever value
//     is already in the column on reseed), only Champion sets the four
//     aura_* fields, and only Guard omits gold_min/gold_max.
//   Read "COALESCE-guarded" as "will protect an admin edit if this seed
//   row is ever missing the field", not as "is currently protecting one" --
//   only the second group's fallback is presently reached by a real row.
//
// SOMET-279: damage_override's COALESCE is now load-bearing rather than
// nominal, and it must stay a COALESCE. Guard used to author 25 here, which
// the tick reads as `(bh.damageOverride ?? c.damage)` -- a non-null override
// SHADOWS the per-instance world_creatures.damage every level-scaled guard
// carries, so a reseed silently flattened a level-50 guard back to 25 (i.e.
// to the applyDamage floor of 1 against a level-50 hostile) with no error.
// The seed row dropped the field; because $7 is then NULL, this UPDATE keeps
// whatever the column already holds -- migration 1714440173000 set it to
// NULL, and reseeding leaves it NULL. Writing EXCLUDED (or a literal) here
// instead would put the landmine straight back. Pinned by
// tests/village_guard_seed_durability.test.js.
//
// SOMET-253 Task 3 dropped attack_kind/attack_range/attack_cooldown/
// projectile_speed/projectile_radius from creature_behaviors -- the attack
// now lives entirely on creature_abilities (seedOneAbility below). `b` (a
// row of seeds/data/creatureBehaviors.js) still carries those fields for
// creature_behaviors_invariants.test.js's field-for-field pin against the
// historical migration array; they are simply not written here any more.
//
// The ::real casts on $3/$4/$6/$7 are load-bearing, not decorative. Postgres
// infers a bare parameter's type from how it is used INSIDE the COALESCE, and
// an integer literal default (400, 800, 1) wins that inference over the real
// column the COALESCE result is later assigned to -- so without the cast,
// every parameter that ever carries a fractional value (move_speed_mult 1.2,
// 1.5, 0.7, 0.6, 1.05, 0.95, 0.9) fails with "invalid input syntax for type
// integer". Found by running the brief's own seed_catalogs_db.test.js:
// seeding the real CREATURE_BEHAVIORS data (not the seed test's integer-only
// fixtures) was the first place a fractional value hit these params.
//
// SOMET-253 Task 4: aura_radius/aura_damage_mult/aura_defense_mult/
// aura_speed_mult/gold_min/gold_max ($8-$13) follow the exact same COALESCE
// rule as aggro_radius/leash_radius/move_speed_mult above, and for the same
// reason those need the ::real cast -- these columns are NOT NULL with a
// non-null column default (0/1/1/1/0/0), so a bare NULL parameter (an
// omitted seed field) would violate the constraint outright rather than
// merely mis-inferring a type. The literal fallbacks inside each COALESCE
// mirror migration 1714440085000_behavior_auras.js's column defaults.
async function seedOneBehavior(db, b) {
  await db.query(
    `INSERT INTO creature_behaviors
       (name, aggro_radius, leash_radius, chase_style,
        preferred_range, move_speed_mult, damage_override,
        aura_radius, aura_damage_mult, aura_defense_mult, aura_speed_mult,
        gold_min, gold_max)
     VALUES ($1, COALESCE($2::real,400), COALESCE($3::real,800),
             $4, COALESCE($5::real,0), COALESCE($6::real,1), $7::real,
             COALESCE($8::real,0), COALESCE($9::real,1), COALESCE($10::real,1), COALESCE($11::real,1),
             COALESCE($12::int,0), COALESCE($13::int,0))
     ON CONFLICT (name) DO UPDATE
       SET chase_style = EXCLUDED.chase_style,
           aggro_radius = COALESCE($2::real, creature_behaviors.aggro_radius),
           leash_radius = COALESCE($3::real, creature_behaviors.leash_radius),
           preferred_range = COALESCE($5::real, creature_behaviors.preferred_range),
           move_speed_mult = COALESCE($6::real, creature_behaviors.move_speed_mult),
           damage_override = COALESCE($7::real, creature_behaviors.damage_override),
           aura_radius = COALESCE($8::real, creature_behaviors.aura_radius),
           aura_damage_mult = COALESCE($9::real, creature_behaviors.aura_damage_mult),
           aura_defense_mult = COALESCE($10::real, creature_behaviors.aura_defense_mult),
           aura_speed_mult = COALESCE($11::real, creature_behaviors.aura_speed_mult),
           gold_min = COALESCE($12::int, creature_behaviors.gold_min),
           gold_max = COALESCE($13::int, creature_behaviors.gold_max),
           updated_at = now()`,
    [b.name, b.aggro_radius ?? null, b.leash_radius ?? null, b.chase_style,
     b.preferred_range ?? null, b.move_speed_mult ?? null,
     b.damage_override ?? null,
     b.aura_radius ?? null, b.aura_damage_mult ?? null, b.aura_defense_mult ?? null, b.aura_speed_mult ?? null,
     b.gold_min ?? null, b.gold_max ?? null],
  );
}

// Upsert on (behavior_id, slot), resolving behavior_id by NAME. A behaviour
// the seeder does not know about is skipped rather than failing the run --
// same posture as grantStartingLoadout skipping a missing catalog name.
//
// COALESCE preserves an admin's hand-authored value only for columns the seed
// file leaves null; every column here is authored, so this is a straight
// overwrite of catalog-owned data. That is deliberate: an ability's stats ARE
// the catalog. Admin-authored abilities on admin-authored behaviours are
// untouched because their behaviour name is not in CREATURE_ABILITIES.
async function seedOneAbility(client, a) {
  const b = await client.query(
    'SELECT id FROM creature_behaviors WHERE name = $1', [a.behavior_name]);
  if (b.rows.length === 0) return { skipped: true };
  await client.query(
    `INSERT INTO creature_abilities
       (behavior_id, slot, name, attack_kind, attack_range, attack_cooldown,
        projectile_speed, projectile_radius, element, damage_mult, knockback)
     VALUES ($1, $2::int, $3, $4, $5::real, $6::real, $7::real, $8::real, $9, $10::real, $11::real)
     ON CONFLICT (behavior_id, slot) DO UPDATE SET
       name = EXCLUDED.name,
       attack_kind = EXCLUDED.attack_kind,
       attack_range = EXCLUDED.attack_range,
       attack_cooldown = EXCLUDED.attack_cooldown,
       projectile_speed = EXCLUDED.projectile_speed,
       projectile_radius = EXCLUDED.projectile_radius,
       element = EXCLUDED.element,
       damage_mult = EXCLUDED.damage_mult,
       knockback = EXCLUDED.knockback,
       updated_at = CURRENT_TIMESTAMP`,
    [b.rows[0].id, a.slot, a.name, a.attack_kind, a.attack_range, a.attack_cooldown,
     a.projectile_speed, a.projectile_radius, a.element, a.damage_mult, a.knockback],
  );
  return { skipped: false };
}

// Guarded by NOT EXISTS, not ON CONFLICT: behavior_drops has no unique
// constraint on (behavior_id, item_type_id) -- unlike creature_abilities'
// (behavior_id, slot), there is no natural key to conflict on here, same as
// creature_drops (see its own NOT EXISTS block in seedCatalogs below, which
// this mirrors). A bare INSERT would stack a duplicate rule on every single
// run, doubling a rung's effective drop odds. The name lookups are a
// cross-join in the same guarded style as 1714440086000_behavior_drops.js: a
// missing behaviour or item type inserts nothing rather than failing the
// seed.
// One chest_loot row (SOMET-438). Keyed on (band, item) rather than on the
// item alone: the same item legitimately appears in several bands, and the
// NOT EXISTS has to let that through while still refusing a duplicate of the
// row it is inserting.
async function seedOneChestLoot(db, d) {
  const r = await db.query(
    `INSERT INTO chest_loot (level_min, level_max, item_type_id, chance, min_qty, max_qty)
     SELECT $1, $2, it.id, $4, $5, $6
       FROM item_types it
      WHERE it.name = $3
        AND NOT EXISTS (
              SELECT 1 FROM chest_loot cl
               WHERE cl.level_min = $1 AND cl.level_max = $2 AND cl.item_type_id = it.id)`,
    [d.level_min, d.level_max, d.item, d.chance, d.min_qty, d.max_qty],
  );
  return r.rowCount;
}

async function seedOneBehaviorDrop(db, d) {
  const r = await db.query(
    `INSERT INTO behavior_drops (behavior_id, item_type_id, chance, min_qty, max_qty)
     SELECT b.id, it.id, $3, $4, $5
       FROM creature_behaviors b, item_types it
      WHERE b.name = $1 AND it.name = $2
        AND NOT EXISTS (
              SELECT 1 FROM behavior_drops bd
               WHERE bd.behavior_id = b.id AND bd.item_type_id = it.id)`,
    [d.behavior, d.item, d.chance, d.min_qty, d.max_qty],
  );
  return r.rowCount;
}

// DO NOTHING rather than DO UPDATE for the same reason as decorations above:
// a designer who has retuned Slime's hp in the admin UI must not have it
// reset by a seeder run. This makes the block a floor -- it restores a
// creature a biome references but that the database is missing, and is
// otherwise a no-op.
//
// SOMET-250 Task 6: shared by HOSTILE_CREATURES (4 legacy creatures) AND
// BESTIARY_P4_CREATURES (288 generated creatures) -- extracted so both lists
// go through the identical upsert + behaviour-resolution path rather than
// maintaining two copies of it, mirroring seedOneTile/seedOneBiome above.
//
// gold_min/gold_max default to 0 in JS (`?? 0`), not left undefined: the
// column is NOT NULL with a column default of 0
// (1714440031000_gold_economy.js), and Postgres only applies a column
// default when the column is OMITTED from the INSERT list entirely -- an
// explicit NULL parameter (what `undefined` becomes via node-postgres) still
// violates the constraint. HOSTILE_CREATURES' four legacy rows always carry
// an explicit gold_min/gold_max; BESTIARY_P4_CREATURES' 288 rows deliberately
// do not (see authority/creatures.js's behaviorGold comment) -- they fall
// back to their rung's own gold_min/gold_max at kill time, so 0 here means
// "no per-creature override", not "no gold".
async function seedOneCreatureType(pool, c) {
  const r = await pool.query(
    `INSERT INTO entity_types
      (name, color, walkable, spawn_tiles, chance, is_creature,
       hp, max_hp, defense, resistances, prompt, gold_min, gold_max)
     VALUES ($1,$2,$3,$4::jsonb,$5,true,$6,$7,$8,$9::jsonb,$10,$11,$12)
     ON CONFLICT (name) DO NOTHING`,
    [c.name, c.color, c.walkable, JSON.stringify(c.spawn_tiles), c.chance,
     c.hp, c.max_hp, c.defense, JSON.stringify(c.resistances), c.prompt,
     c.gold_min ?? 0, c.gold_max ?? 0],
  );

  // Resolve `c.behavior_name` (the rung name every HOSTILE_CREATURES and
  // BESTIARY_P4_CREATURES row now carries, per the P4 legacy remap and
  // generator respectively) to `behavior_id` by name against
  // creature_behaviors, falling back to the same faction rule
  // 1714440081000_entity_behavior.js's backfill uses (guard faction ->
  // Guard, everything else -> Line) only for the case a row has neither --
  // there is none today, but the rule stays general rather than hardcoded so
  // it cannot desync from that migration if a profile is ever renamed.
  // COALESCE, not a bare SET, so a behaviour an admin already assigned by
  // hand is never reset: this only fills a gap. This is what closes the gap
  // the "seeding restores a creature that is missing from the catalog" test
  // exposed: the INSERT above never set behavior_id, so a creature restored
  // after being deleted (e.g. Wolf, after a dev-volume rebuild) came back
  // with none.
  await pool.query(
    `UPDATE entity_types
       SET behavior_id = COALESCE(behavior_id,
         (SELECT id FROM creature_behaviors WHERE name = $2))
     WHERE name = $1`,
    [c.name, c.behavior_name || (c.faction === 'guard' ? 'Guard' : 'Line')],
  );

  return r.rowCount;
}

// Guarded by NOT EXISTS, not ON CONFLICT: creature_drops has no unique
// constraint on (entity_type_id, item_type_id) -- see
// 1714440018000_create_loot.js -- so a bare INSERT would stack a duplicate
// rule on every single run, doubling the creature's effective drop odds. The
// name lookups are a cross-join in the same guarded style as the migration: a
// missing creature or item type inserts nothing rather than failing the
// seed.
//
// SOMET-250 Task 6: shared by CREATURE_DROPS (Wolf's one hand-authored rule)
// AND BESTIARY_P4_DROPS (288 generated rules), same reason as
// seedOneCreatureType above.
async function seedOneCreatureDrop(pool, d) {
  const r = await pool.query(
    `INSERT INTO creature_drops (entity_type_id, item_type_id, chance, min_qty, max_qty)
     SELECT et.id, it.id, $3, $4, $5
       FROM entity_types et, item_types it
      WHERE et.name = $1 AND it.name = $2
        AND NOT EXISTS (
              SELECT 1 FROM creature_drops cd
               WHERE cd.entity_type_id = et.id AND cd.item_type_id = it.id)`,
    [d.creature, d.item, d.chance, d.min_qty, d.max_qty],
  );
  return r.rowCount;
}

// A playable class (SOMET-258). Same DO NOTHING posture as every other
// seedOne* here -- this restores a class that is missing, and never overwrites
// one an admin has retuned by hand.
//
// is_playable is set explicitly rather than left to the column default: the
// default is false, so a restored class that omitted it would come back
// invisible to the character-creation picker -- present in the catalog,
// unusable in the game, and silent about it.
//
// SOMET-471: it is now READ OFF THE ROW rather than hardcoded `true`. The
// Ranger entry is in PLAYABLE_CLASSES precisely BECAUSE it must be restorable
// -- live characters reference it -- but it must come back DEMOTED, and a
// hardcoded true would re-open a retired class on every volume rebuild.
// main_stat rides along for the same reason: a restored class with no main
// stat has no passive-tree sector while still looking fine in the picker.
async function seedOnePlayableClass(pool, c) {
  const r = await pool.query(
    `INSERT INTO entity_types
      (name, color, walkable, spawn_tiles, chance, is_playable, main_stat,
       strength, dexterity, constitution, intelligence, wisdom, charisma,
       hp, max_hp, hp_regen_rate, mana, max_mana, mana_regen_rate)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     ON CONFLICT (name) DO NOTHING`,
    [c.name, c.color, c.walkable, JSON.stringify(c.spawn_tiles), c.chance,
     // `!== false`, not a bare truthiness check: a row that simply forgot the
     // flag stays playable (the pre-471 behaviour), and only an explicit
     // `is_playable: false` demotes.
     c.is_playable !== false, c.main_stat || null,
     c.strength, c.dexterity, c.constitution, c.intelligence, c.wisdom, c.charisma,
     c.hp, c.max_hp, c.hp_regen_rate, c.mana, c.max_mana, c.mana_regen_rate],
  );
  return r.rowCount;
}

// One class's starting-gear row. Guarded by the cross-join on names, in the
// same style as the migration and as seedOneCreatureDrop: a catalog missing
// the class or the item inserts nothing rather than failing the whole seed.
// ON CONFLICT is safe here (unlike creature_drops) because class_loadouts DOES
// carry a unique constraint on (entity_type_id, item_type_id).
//
// SOMET-492: `equipSlot` and `socketInto` (both optional, both NULL for every
// class but the Cultist) ride along, and unlike `quantity` they are written on
// CONFLICT as well as on INSERT. That asymmetry is the point: SOMET-335's trap
// is a migration-authored fact that a re-seed silently reverts, and
// playable_classes_db.test.js deletes and re-seeds these very rows. With a
// bare DO NOTHING a re-seeded Cultist would get its staff and stone back with
// no equip and no socket -- inventory identical, class inert, every test on
// the row COUNT still green. quantity keeps its DO NOTHING semantics because
// nothing here changes it and an operator-adjusted quantity is not this
// slice's to clobber.
//
// `socketInto` is resolved through a LEFT JOIN so a spec naming a host item
// that is not in the catalog leaves NULL (the item is still granted, just
// loose) rather than dropping the whole row via a failed cross-join -- the
// same fail-safe posture as the guard above.
async function seedOneClassLoadout(pool, l) {
  const r = await pool.query(
    `INSERT INTO class_loadouts (entity_type_id, item_type_id, quantity, equip_slot, socket_into_item_type_id)
     SELECT e.id, i.id, $3, $4, h.id
       FROM entity_types e
       CROSS JOIN item_types i
       LEFT JOIN item_types h ON h.name = $5
      WHERE e.name = $1 AND i.name = $2
     ON CONFLICT (entity_type_id, item_type_id) DO UPDATE
       SET equip_slot = EXCLUDED.equip_slot,
           socket_into_item_type_id = EXCLUDED.socket_into_item_type_id
     RETURNING (xmax = 0) AS inserted`,
    [l.class, l.item, l.quantity, l.equipSlot || null, l.socketInto || null],
  );
  // rowCount is 1 for an UPDATE too, so counting it would make the seeder
  // report "restored 17 missing rows" on every run of a fully-seeded database.
  // xmax = 0 is Postgres' own "this tuple was inserted, not updated by the
  // conflict clause" tell, so the restored-count keeps meaning what it says.
  return r.rows.length && r.rows[0].inserted ? 1 : 0;
}

async function seedCatalogs(pool) {
  let tiles = 0;
  for (const t of DEFAULT_TILE_TYPES) {
    await seedOneTile(pool, t);
    tiles += 1;
  }

  let biomes = 0;
  for (const b of STARTER_BIOMES) {
    await seedOneBiome(pool, b);
    biomes += 1;
  }

  for (const b of CREATURE_BEHAVIORS) {
    await seedOneBehavior(pool, b);
  }
  console.log(`Seeded ${CREATURE_BEHAVIORS.length} creature behaviors`);

  let abilities = 0;
  for (const a of CREATURE_ABILITIES) {
    const r = await seedOneAbility(pool, a);
    if (!r.skipped) abilities += 1;
  }
  console.log(`Seeded ${abilities} creature abilities`);

  // NOTE: decorationTypes.js also exports SIZE_FIXES (Tree/Stone/IceRock
  // display size). Deliberately NOT consumed here. SIZE_FIXES is a ONE-TIME
  // correction that belongs to migration 1714440042000_decoration_types.js —
  // its own `down` reverts those columns back to 0x0, which only makes sense
  // for a migration step, not something this idempotent seeder should
  // replay on every run. Applying it here would silently stomp an admin's
  // hand-resized decoration every time `make seed-catalogs` runs, which is
  // exactly the "never cost an admin something they added by hand" rule
  // this file exists to uphold. SIZE_FIXES stays exported for the
  // migration's own use only.

  let decorations = 0;
  for (const d of NEW_DECORATIONS) {
    // Column list and ON CONFLICT behaviour mirror
    // 1714440042000_decoration_types.js's INSERT exactly: DO NOTHING, not DO
    // UPDATE, so an admin who has already edited one of these decoration
    // entity types is never overwritten back to the seed defaults.
    await pool.query(
      `INSERT INTO entity_types
        (name, is_creature, walkable, render_mode, spawn_tiles, chance, display_width, display_height, color)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)
       ON CONFLICT (name) DO NOTHING`,
      [d.name, d.is_creature, d.walkable, d.render_mode, JSON.stringify(d.spawn_tiles),
       d.chance, d.display_width, d.display_height, d.color],
    );
    decorations += 1;
  }

  // Creatures, then their drop rules. HOSTILE_CREATURES (4 legacy) and
  // BESTIARY_P4_CREATURES (288 generated, SOMET-250 Task 6) go through the
  // same seedOneCreatureType path -- see its comment above for the upsert
  // policy and the gold_min/gold_max and behavior_name resolution rules.
  let creatures = 0;
  for (const c of [...HOSTILE_CREATURES, ...BESTIARY_P4_CREATURES]) {
    creatures += await seedOneCreatureType(pool, c);
  }

  // CREATURE_DROPS (Wolf's one hand-authored rule) and BESTIARY_P4_DROPS (288
  // generated rules, SOMET-250 Task 6) go through the same
  // seedOneCreatureDrop path -- see its comment above for why NOT EXISTS
  // rather than ON CONFLICT.
  let drops = 0;
  for (const d of [...CREATURE_DROPS, ...BESTIARY_P4_DROPS]) {
    drops += await seedOneCreatureDrop(pool, d);
  }

  // Per-rung fallback drops (SOMET-253 Task 7). Same restore-a-floor posture
  // as the creature_drops block above; see seedOneBehaviorDrop's comment for
  // why NOT EXISTS rather than ON CONFLICT.
  let behaviorDrops = 0;
  for (const d of BEHAVIOR_DROPS) {
    behaviorDrops += await seedOneBehaviorDrop(pool, d);
  }

  let chestLoot = 0;
  for (const d of CHEST_LOOT) {
    chestLoot += await seedOneChestLoot(pool, d);
  }

  // Playable classes, then their starting gear. Ordered that way because the
  // loadout rows resolve their class by name and insert nothing if it is
  // absent -- seeding gear first would silently no-op on a wiped volume.
  let classes = 0;
  for (const c of PLAYABLE_CLASSES) {
    classes += await seedOnePlayableClass(pool, c);
  }
  let classLoadouts = 0;
  for (const l of CLASS_LOADOUTS) {
    classLoadouts += await seedOneClassLoadout(pool, l);
  }

  return {
    tiles, biomes, decorations, creatures, drops, abilities, behaviorDrops,
    chestLoot, classes, classLoadouts,
  };
}

module.exports = {
  seedCatalogs, seedOneTile, seedOneBiome, seedOneBehavior, seedOneAbility, seedOneBehaviorDrop,
  seedOneChestLoot,
  seedOneCreatureType, seedOneCreatureDrop, seedOnePlayableClass, seedOneClassLoadout,
};

if (require.main === module) {
  const env = dotenv.config({ path: path.resolve(__dirname, '../../.env') }).parsed || {};
  const url = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set in .env'); process.exit(1); }
  const pool = new Pool({ connectionString: url });
  seedCatalogs(pool)
    .then((n) => {
      console.log(`seeded ${n.tiles} tiles, ${n.biomes} biomes, ${n.decorations} decorations`);
      // Creatures and drops report rows actually INSERTED (not rows
      // attempted, as the three counts above do) because their DO NOTHING /
      // NOT EXISTS guards make a repeat run legitimately write zero. Zero is
      // the normal steady state here, so say so rather than look like a bug.
      console.log(`restored ${n.creatures} missing creature types, ${n.drops} missing drop rules, `
        + `${n.behaviorDrops} missing rung drop rules`);
      console.log(`restored ${n.classes} missing playable classes, ${n.classLoadouts} missing class loadout rows`);
      console.log(`restored ${n.chestLoot} missing chest loot rows`);
    })
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
