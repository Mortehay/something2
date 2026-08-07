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
const { HOSTILE_CREATURES, CREATURE_DROPS } = require('../seeds/data/entityTypes.js');
const { CREATURE_BEHAVIORS } = require('../seeds/data/creatureBehaviors.js');

// COALESCE, not plain EXCLUDED, for the four columns below.
//
// Every existing terrain tile carries a prompt in the database that is NOT in
// DEFAULT_TILE_TYPES -- `grass` reads "lush green meadow grass", and so on for
// all eleven. Those were authored in the admin UI. Writing EXCLUDED
// unconditionally would wipe every one of them on the next `make
// seed-catalogs`, which is precisely what this file's header rule forbids.
//
// So a seed entry that OMITS a field passes NULL and COALESCE keeps whatever
// the row already holds; a seed entry that SPECIFIES one overwrites. New tiles
// (no existing row) fall to the column defaults via the same COALESCE.
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
// supplying an EMPTY one keeps whatever the row already holds. The other seven
// columns are populated on every entry, and `biomes` has exactly these eight
// columns, so there is no column-omission hazard here of the kind the tile
// path had.
//
// Split out of seedCatalogs, mirroring seedOneTile, so the preservation rule
// can be tested against the REAL statement rather than a restatement of it.
async function seedOneBiome(db, b) {
  await db.query(
    `INSERT INTO biomes (name, terrain_tiles, flora_types, creature_types, palette, art_style, exclusions, color)
     VALUES ($1,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7,$8)
     ON CONFLICT (name) DO UPDATE
       SET terrain_tiles = EXCLUDED.terrain_tiles, flora_types = EXCLUDED.flora_types,
           creature_types = CASE
             WHEN jsonb_array_length(EXCLUDED.creature_types) = 0 THEN biomes.creature_types
             ELSE EXCLUDED.creature_types END,
           palette = EXCLUDED.palette,
           art_style = EXCLUDED.art_style, exclusions = EXCLUDED.exclusions,
           color = EXCLUDED.color`,
    [b.name, JSON.stringify(b.terrain_tiles ?? []), JSON.stringify(b.flora_types ?? []),
     JSON.stringify(b.creature_types ?? []), JSON.stringify(b.palette ?? []),
     b.art_style, b.exclusions, b.color],
  );
}

// COALESCE for every optional field, same rule as seedOneTile: a seed entry
// that OMITS a field must not clobber what an admin tuned in the UI. The
// non-optional five (name, attack_kind, attack_range, attack_cooldown,
// chase_style) are the profile's identity and are always written.
//
// The ::real casts on $5/$6/$7/$8/$10/$11/$12 are load-bearing, not
// decorative. Postgres infers a bare parameter's type from how it is used
// INSIDE the COALESCE, and an integer literal default (0, 400, 800, 1) wins
// that inference over the real column the COALESCE result is later assigned
// to -- so without the cast, every parameter that ever carries a fractional
// value (move_speed_mult 1.2, 1.5, 0.7, 0.6, 1.05, 0.95, 0.9) fails with
// "invalid input syntax for type integer". Found by running the brief's own
// seed_catalogs_db.test.js: seeding the real CREATURE_BEHAVIORS data (not the
// seed test's integer-only fixtures) was the first place a fractional value
// hit these params.
async function seedOneBehavior(db, b) {
  await db.query(
    `INSERT INTO creature_behaviors
       (name, attack_kind, attack_range, attack_cooldown, projectile_speed,
        projectile_radius, aggro_radius, leash_radius, chase_style,
        preferred_range, move_speed_mult, damage_override)
     VALUES ($1,$2,$3,$4,
             COALESCE($5::real,0), COALESCE($6::real,0), COALESCE($7::real,400), COALESCE($8::real,800),
             $9, COALESCE($10::real,0), COALESCE($11::real,1), $12::real)
     ON CONFLICT (name) DO UPDATE
       SET attack_kind = EXCLUDED.attack_kind,
           attack_range = EXCLUDED.attack_range,
           attack_cooldown = EXCLUDED.attack_cooldown,
           chase_style = EXCLUDED.chase_style,
           projectile_speed = COALESCE($5::real, creature_behaviors.projectile_speed),
           projectile_radius = COALESCE($6::real, creature_behaviors.projectile_radius),
           aggro_radius = COALESCE($7::real, creature_behaviors.aggro_radius),
           leash_radius = COALESCE($8::real, creature_behaviors.leash_radius),
           preferred_range = COALESCE($10::real, creature_behaviors.preferred_range),
           move_speed_mult = COALESCE($11::real, creature_behaviors.move_speed_mult),
           damage_override = COALESCE($12::real, creature_behaviors.damage_override),
           updated_at = now()`,
    [b.name, b.attack_kind, b.attack_range, b.attack_cooldown,
     b.projectile_speed ?? null, b.projectile_radius ?? null,
     b.aggro_radius ?? null, b.leash_radius ?? null, b.chase_style,
     b.preferred_range ?? null, b.move_speed_mult ?? null,
     b.damage_override ?? null],
  );
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

  // Creatures, then their drop rules. DO NOTHING rather than DO UPDATE for
  // the same reason as decorations above: a designer who has retuned Slime's
  // hp in the admin UI must not have it reset by a seeder run. This makes the
  // block a floor -- it restores a creature a biome references but that the
  // database is missing, and is otherwise a no-op.
  let creatures = 0;
  for (const c of HOSTILE_CREATURES) {
    const r = await pool.query(
      `INSERT INTO entity_types
        (name, color, walkable, spawn_tiles, chance, is_creature,
         hp, max_hp, defense, resistances, prompt, gold_min, gold_max)
       VALUES ($1,$2,$3,$4::jsonb,$5,true,$6,$7,$8,$9::jsonb,$10,$11,$12)
       ON CONFLICT (name) DO NOTHING`,
      [c.name, c.color, c.walkable, JSON.stringify(c.spawn_tiles), c.chance,
       c.hp, c.max_hp, c.defense, JSON.stringify(c.resistances), c.prompt,
       c.gold_min, c.gold_max],
    );
    creatures += r.rowCount;
  }

  // Guarded by NOT EXISTS, not ON CONFLICT: creature_drops has no unique
  // constraint on (entity_type_id, item_type_id) -- see
  // 1714440018000_create_loot.js -- so a bare INSERT would stack a duplicate
  // rule on every single run, doubling the creature's effective drop odds.
  // The name lookups are a cross-join in the same guarded style as the
  // migration: a missing creature or item type inserts nothing rather than
  // failing the seed.
  let drops = 0;
  for (const d of CREATURE_DROPS) {
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
    drops += r.rowCount;
  }

  return { tiles, biomes, decorations, creatures, drops };
}

module.exports = { seedCatalogs, seedOneTile, seedOneBiome, seedOneBehavior };

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
      console.log(`restored ${n.creatures} missing creature types, ${n.drops} missing drop rules`);
    })
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
