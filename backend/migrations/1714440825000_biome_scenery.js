exports.shorthands = undefined;

// Biome scenery density, rollout step 1 (spec: docs/superpowers/specs/
// 2026-10-22-biome-scenery-density-design.md). Purely ADDITIVE:
//   - five columns (entity_types.scenery_layer / block_radius / max_per_tile,
//     biomes.feature_density / cover_density);
//   - the SCENERY_TYPES rows, ON CONFLICT DO NOTHING (an empty prompt is
//     filled, nothing else is touched, so an admin edit survives a re-run);
//   - existing decorations' spawn_tiles WIDENED and their block_radius set
//     where still NULL;
//   - each biome's flora_types APPENDED to (names already present are
//     skipped; nothing is removed or reordered);
//   - cover_density set where it is still NULL (unset); an admin's deliberate
//     0 means "no ground cover" and survives a re-run.
// Catalogue data lives in seeds/data/sceneryCatalog.js so
// `make seed-catalogs` and this migration cannot drift (same precedent as
// 1714440042000_decoration_types.js). `down` drops the columns only and
// leaves the rows alone; a later `up` that re-creates the columns re-asserts
// scenery_layer / block_radius / max_per_tile for the catalogue rows.
const {
  SCENERY_TYPES, SPAWN_TILE_ADDITIONS, BIOME_SCENERY, EXISTING_BLOCK_RADIUS,
} = require('../seeds/data/sceneryCatalog.js');

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const jsonb = (v) => `${q(JSON.stringify(v))}::jsonb`;

// current ∪ names, appended in order, skipping what is already there.
const appendMissing = (column, table, names) =>
  `${column} || COALESCE((SELECT jsonb_agg(e.t ORDER BY e.o)
      FROM jsonb_array_elements_text(${jsonb(names)}) WITH ORDINALITY AS e(t, o)
      WHERE NOT (${table}.${column} ? e.t)), '[]'::jsonb)`;

// A migration's statements are static SQL, so "did `up` just create the
// columns?" is carried in a session setting: recorded before ADD COLUMN,
// consulted by the re-assert below, cleared at the end.
const FRESH = 'scenery_migration.fresh_columns';

exports.up = (pgm) => {
  pgm.sql(`SELECT set_config('${FRESH}', CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'entity_types' AND column_name = 'scenery_layer')
    THEN 'no' ELSE 'yes' END, false)`);
  pgm.sql(`ALTER TABLE entity_types
    ADD COLUMN IF NOT EXISTS scenery_layer text NOT NULL DEFAULT 'feature'
      CONSTRAINT entity_types_scenery_layer_check CHECK (scenery_layer IN ('feature', 'cover')),
    ADD COLUMN IF NOT EXISTS block_radius integer,
    ADD COLUMN IF NOT EXISTS max_per_tile integer NOT NULL DEFAULT 2`);
  pgm.sql(`ALTER TABLE biomes
    ADD COLUMN IF NOT EXISTS feature_density real,
    ADD COLUMN IF NOT EXISTS cover_density real`);

  for (const t of SCENERY_TYPES) {
    pgm.sql(`INSERT INTO entity_types
      (name, is_creature, walkable, render_mode, spawn_tiles, chance, display_width, display_height,
       color, prompt, scenery_layer, block_radius, max_per_tile)
      VALUES (${q(t.name)}, false, ${t.walkable}, 'static', ${jsonb(t.spawn_tiles)}, ${t.chance},
        ${t.display_width}, ${t.display_height}, ${q(t.color)}, ${q(t.prompt)},
        ${q(t.scenery_layer)}, ${t.block_radius}, ${t.max_per_tile})
      ON CONFLICT (name) DO UPDATE
        SET prompt = COALESCE(NULLIF(entity_types.prompt, ''), EXCLUDED.prompt)`);
  }

  // After a down -> up the rows survive but the columns come back at their
  // defaults (every cover type a 'feature', radius NULL, max 2), which would
  // silently turn the catalogue into features. Re-assert the catalogue values
  // -- but ONLY when this run created the columns: on a normal forward apply
  // they hold admin edits that must survive.
  for (const t of SCENERY_TYPES) {
    pgm.sql(`UPDATE entity_types
      SET scenery_layer = ${q(t.scenery_layer)}, block_radius = ${t.block_radius}, max_per_tile = ${t.max_per_tile}
      WHERE name = ${q(t.name)} AND current_setting('${FRESH}', true) = 'yes'`);
  }

  for (const [name, tiles] of Object.entries(SPAWN_TILE_ADDITIONS)) {
    pgm.sql(`UPDATE entity_types
      SET spawn_tiles = ${appendMissing('spawn_tiles', 'entity_types', tiles)}
      WHERE name = ${q(name)}`);
  }
  for (const [name, r] of Object.entries(EXISTING_BLOCK_RADIUS)) {
    pgm.sql(`UPDATE entity_types SET block_radius = ${r} WHERE name = ${q(name)} AND block_radius IS NULL`);
  }
  pgm.sql(`SELECT set_config('${FRESH}', '', false)`);

  for (const [name, s] of Object.entries(BIOME_SCENERY)) {
    pgm.sql(`UPDATE biomes
      SET flora_types = ${appendMissing('flora_types', 'biomes', s.add)}
      WHERE name = ${q(name)}`);
    pgm.sql(`UPDATE biomes SET cover_density = ${s.cover_density}
      WHERE name = ${q(name)} AND cover_density IS NULL`);
    if (s.feature_density !== null) {
      pgm.sql(`UPDATE biomes SET feature_density = ${s.feature_density}
        WHERE name = ${q(name)} AND feature_density IS NULL`);
    }
  }
};

exports.down = (pgm) => {
  pgm.sql('ALTER TABLE biomes DROP COLUMN IF EXISTS cover_density, DROP COLUMN IF EXISTS feature_density');
  pgm.sql('ALTER TABLE entity_types DROP COLUMN IF EXISTS max_per_tile, DROP COLUMN IF EXISTS block_radius, DROP COLUMN IF EXISTS scenery_layer');
};
