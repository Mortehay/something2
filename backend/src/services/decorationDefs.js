// Shared decoration-def loader. Both the REST /chunk preview
// (index.js's generateChunkDecorations call) and the authority's
// ServerMap blocking-decoration overlay (authority/server.js) must place
// decorations IDENTICALLY, and generateChunkDecorations picks the winning
// def by iterating this array and `break`-ing on the first spawn_tiles
// match -- so array order decides which def's `walkable` flag wins when a
// tile's terrain is eligible for more than one def. Without an ORDER BY,
// Postgres row order is unstable (and can change out from under a running
// process, e.g. the sprite-approval `UPDATE entity_types SET image = ...`
// reorders the heap), which let /chunk (queries per request) and the
// authority (queries once at world activation, then caches) silently
// drift out of order and disagree on which tiles block -- client/server
// rubber-banding. ONE function, ONE query, ORDER BY id ASC (matching this
// repo's tile_types ORDER BY id ASC convention), imported by both call
// sites so they cannot drift again.
//
// Note: the authority caches the result of this call at world activation
// (see loadWorld in authority/server.js), so adding a NEW decoration type
// mid-session requires reloading/restarting that world's authority process
// to pick it up. Rare and admin-only; acceptable.
async function loadDecorationDefs(pool) {
  const { rows } = await pool.query(
    `SELECT name, walkable, spawn_tiles, chance
       FROM entity_types
      WHERE is_creature = false
        AND spawn_tiles IS NOT NULL
        AND jsonb_array_length(spawn_tiles) > 0
      ORDER BY id ASC`,
  );
  return rows;
}

module.exports = { loadDecorationDefs };
