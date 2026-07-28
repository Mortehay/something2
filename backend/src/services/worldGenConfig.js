// The ONE place a `worlds` row becomes a generation config.
//
// Two callers must agree exactly: GET /api/worlds/:id/chunk (what the client
// renders and collides against) and the authority's loadWorld (what the server
// collides against). They used to hand-build near-identical object literals
// several hundred lines apart in different files; every field added to one and
// forgotten in the other is a silent client/server divergence -- terrain the
// client draws that the server doesn't have, and rubber-banding. Adding a
// field HERE reaches both by construction.
//
// `biomes` is the resolved record list from services/biomes.js (already in the
// world's declared banding order), not the raw name array off the row.
function buildWorldGenConfig({ row, tileTypes, doorways, villages, biomes }) {
  return {
    seed: Number(row.seed),
    chunkSize: row.chunk_size,
    tileTypes,
    width: row.width,
    height: row.height,
    doorways: doorways || [],
    villages: villages || [],
    entry_spawn: row.entry_spawn,
    biomes: biomes || [],
    // null (not undefined) so worldConfig's derive-from-bounds branch runs.
    biomeCell: Number.isFinite(row.biome_cell) ? row.biome_cell : null,
  };
}

module.exports = { buildWorldGenConfig };
