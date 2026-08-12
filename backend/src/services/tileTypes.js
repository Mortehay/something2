// The ONE place a tile_types row becomes the shape the game engine expects.
//
// Lived in src/index.js as getTileTypesMap, closing over that module's `pool`,
// which made it unreachable from services without a circular import --
// worldPopulation.js needs it, and needs it on ITS caller's transaction.
// Takes `db` (a Pool or a checked-out Client) like loadBiomes, fetchVillages
// and fetchLinks already do.
async function loadTileTypes(db) {
  const result = await db.query('SELECT * FROM tile_types ORDER BY id ASC');
  const tileTypes = {};
  result.rows.forEach((row) => {
    tileTypes[row.name] = {
      id: row.id,
      color: row.color,
      walkable: row.walkable,
      speed: row.speed,
      image: row.image,
      sprite: row.sprite || null,
      render_mode: row.render_mode || 'color',
      validNeighbors: row.valid_neighbors || [],
      // Cache-busting key for the client's asset URLs. SOMET-235: generated
      // keys are now job-id-scoped and never reused across regenerations, so
      // an approval already points at a brand-new key/URL; this updated_at
      // is now redundant-but-harmless insurance against /api/assets's
      // max-age=300, not the thing that makes a fresh texture render.
      updated_at: row.updated_at,
      wall_height: row.wall_height ?? 0,
      place_order: row.place_order ?? 0
    };
  });
  return tileTypes;
}

module.exports = { loadTileTypes };
