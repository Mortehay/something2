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
const { NEW_DECORATIONS, SIZE_FIXES } = require('../seeds/data/decorationTypes.js');

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

  // SIZE_FIXES: a corrective UPDATE for decorations (Tree/Stone/IceRock) that
  // were seeded 0x0 by an earlier migration, mirrored from
  // 1714440042000_decoration_types.js's `up`. Applied by name, same as the
  // tile/biome upserts above — it does not delete or insert rows, only
  // corrects display size on rows that already exist, so a hand-added tile
  // or biome is never at risk. Included here (not just replayed once by the
  // migration) because decorationTypes.js explicitly re-exports SIZE_FIXES
  // for the seeder to read too — see that file's and the migration's header
  // comments.
  for (const [name, { w, h }] of Object.entries(SIZE_FIXES)) {
    await pool.query(
      'UPDATE entity_types SET display_width = $1, display_height = $2 WHERE name = $3',
      [w, h, name],
    );
  }

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
