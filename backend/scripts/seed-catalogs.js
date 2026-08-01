#!/usr/bin/env node
// Upsert the tile / biome / decoration catalogs. Run via `make seed-catalogs`.
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

async function seedCatalogs(pool) {
  let tiles = 0;
  for (const t of DEFAULT_TILE_TYPES) {
    await pool.query(
      `INSERT INTO tile_types (name, color, walkable, speed, image, valid_neighbors)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)
       ON CONFLICT (name) DO UPDATE
         SET color = EXCLUDED.color, walkable = EXCLUDED.walkable,
             speed = EXCLUDED.speed, valid_neighbors = EXCLUDED.valid_neighbors`,
      [t.name, t.color, t.walkable, t.speed, t.image ?? '', JSON.stringify(t.valid_neighbors ?? [])],
    );
    tiles += 1;
  }

  let biomes = 0;
  for (const b of STARTER_BIOMES) {
    await pool.query(
      `INSERT INTO biomes (name, terrain_tiles, flora_types, creature_types, palette, art_style, exclusions, color)
       VALUES ($1,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7,$8)
       ON CONFLICT (name) DO UPDATE
         SET terrain_tiles = EXCLUDED.terrain_tiles, flora_types = EXCLUDED.flora_types,
             creature_types = EXCLUDED.creature_types, palette = EXCLUDED.palette,
             art_style = EXCLUDED.art_style, exclusions = EXCLUDED.exclusions,
             color = EXCLUDED.color`,
      [b.name, JSON.stringify(b.terrain_tiles), JSON.stringify(b.flora_types),
       JSON.stringify(b.creature_types), JSON.stringify(b.palette),
       b.art_style, b.exclusions, b.color],
    );
    biomes += 1;
  }

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

  return { tiles, biomes, decorations };
}

module.exports = { seedCatalogs };

if (require.main === module) {
  const env = dotenv.config({ path: path.resolve(__dirname, '../../.env') }).parsed || {};
  const url = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set in .env'); process.exit(1); }
  const pool = new Pool({ connectionString: url });
  seedCatalogs(pool)
    .then((n) => { console.log(`seeded ${n.tiles} tiles, ${n.biomes} biomes, ${n.decorations} decorations`); })
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
