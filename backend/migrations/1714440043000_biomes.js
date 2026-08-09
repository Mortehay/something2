exports.shorthands = undefined;

// Data moved to backend/seeds/data/biomes.js so `make seed-catalogs` and this
// migration cannot drift apart. Migration behaviour is unchanged: the array
// is byte-identical and migrations only ever run once.
const { STARTER_BIOMES } = require('../seeds/data/biomes.js');

exports.up = (pgm) => {
  pgm.createTable('biomes', {
    id: 'id',
    name: { type: 'varchar(200)', notNull: true, unique: true },
    terrain_tiles: { type: 'jsonb', notNull: true, default: '[]' },
    flora_types: { type: 'jsonb', notNull: true, default: '[]' },
    creature_types: { type: 'jsonb', notNull: true, default: '[]' },
    palette: { type: 'jsonb', notNull: true, default: '[]' },
    art_style: { type: 'text', notNull: true, default: '' },
    exclusions: { type: 'text', notNull: true, default: '' },
    color: { type: 'varchar(50)', notNull: true, default: '#888888' },
    created_at: { type: 'timestamp', notNull: true, default: pgm.func('current_timestamp') },
    updated_at: { type: 'timestamp', notNull: true, default: pgm.func('current_timestamp') },
  });

  // biomes: the biome NAMES this world may contain, in banding order.
  // biome_cell: noise cell size of the biome field in tiles; null = derived
  // from the world's bounds by worldConfig (see mapService.js).
  pgm.addColumns('worlds', {
    biomes: { type: 'jsonb', notNull: true, default: '[]' },
    biome_cell: { type: 'integer', notNull: false },
  });

  for (const b of STARTER_BIOMES) {
    pgm.sql(`INSERT INTO biomes
      (name, terrain_tiles, flora_types, creature_types, palette, art_style, exclusions, color)
      VALUES ('${b.name}',
        '${JSON.stringify(b.terrain_tiles)}'::jsonb,
        '${JSON.stringify(b.flora_types)}'::jsonb,
        '${JSON.stringify(b.creature_types)}'::jsonb,
        '${JSON.stringify(b.palette)}'::jsonb,
        '${b.art_style}', '${b.exclusions}', '${b.color}')
      ON CONFLICT (name) DO NOTHING`);
  }
};

exports.down = (pgm) => {
  // world_chunks generated while a world had biomes carry biome-banded
  // terrain baked into their persisted data; regenerating is cheap, so drop
  // them rather than leave a rolled-back DB serving mismatched terrain.
  pgm.sql(`DELETE FROM world_chunks USING worlds
    WHERE world_chunks.world_id = worlds.id
      AND jsonb_array_length(worlds.biomes) > 0`);
  pgm.dropColumns('worlds', ['biomes', 'biome_cell']);
  pgm.dropTable('biomes');
};
