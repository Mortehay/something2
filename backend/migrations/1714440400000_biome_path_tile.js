/* eslint-disable camelcase */

// SOMET-349 follow-up: give each biome its own road tile.
//
// Before this, roads had no tile of their own. mapService stamped every road
// in `cfg.pathTile` -- the tile detectPathTile's regex happened to hit first in
// catalog id order, which is `sand` -- the same tile the ambient carvePaths
// noise uses. A village-to-doorway highway was therefore drawn in exactly the
// same bright yellow as the procedural squiggles crossing the whole map, and
// read as terrain rather than as a road.
//
// NULLABLE, and left NULL here on purpose. mapService.roadTileAt falls back to
// the world's ambient path tile for any biome without one, so this migration
// alone changes nothing that renders: every existing world keeps generating
// byte-identical chunks until `make seed-catalogs` fills the column in from
// seeds/data/biomes.js. That ordering is deliberate -- the schema change and
// the appearance change are separately revertible.
//
// The seed file is the source of truth for the VALUES (per the repo rule that
// a re-seed must not undo a migration): this migration deliberately does not
// write any, so there is nothing here for a re-seed to contradict.

exports.up = (pgm) => {
  pgm.addColumn('biomes', {
    path_tile: {
      type: 'text',
      notNull: false,
      default: null,
      comment: 'tile_types.name stamped for roads crossing this biome; NULL falls back to the world ambient path tile',
    },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('biomes', 'path_tile');
};
