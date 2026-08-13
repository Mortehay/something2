// The waypoint network (SOMET-292). One reader, one writer, one activator, one
// list -- everything that touches the `waypoints` / `character_waypoints`
// tables goes through here.
//
// That is not tidiness. This repo's recorded failure (SOMET-249) is a feature
// written by one loader and read by another that never sees it: green tests,
// dead feature. A waypoint has exactly one runtime reader (fetchWaypoints, from
// the authority's loadWorld) and exactly one authoring writer (upsertWaypoint,
// from seed-map.js), so there is no second path for the two to disagree on.

// Pixels per map tile. Waypoint coordinates are pixels (matching
// map_links.from_x/from_y) but a waypoint is triggered by TILE: a player is
// never standing on a single pixel. Duplicated from the same constant in
// authority/server.js deliberately -- requiring that module here would drag the
// whole websocket authority into seed-map.js and into every unit test.
const MAP_TILE_SIZE = 100;

// The tile key a waypoint lives on. The authority's tick loop derives the
// player's key with the identical arithmetic (Math.floor(centre / 100)), which
// is what makes an O(1) Map lookup correct rather than approximately correct.
function waypointTileKey(x, y) {
  return `${Math.floor(y / MAP_TILE_SIZE)},${Math.floor(x / MAP_TILE_SIZE)}`;
}

// Every waypoint in one world. THE runtime read: loadWorld calls this once per
// world it activates, and the tick loop matches players against the result.
async function fetchWaypoints(pool, worldId) {
  const r = await pool.query(
    `SELECT id, world_id, x, y, name, map_link_id
       FROM waypoints WHERE world_id = $1 ORDER BY created_at ASC`,
    [worldId],
  );
  return r.rows.map((w) => ({
    id: w.id,
    worldId: w.world_id,
    x: Number(w.x),
    y: Number(w.y),
    name: w.name,
    mapLinkId: w.map_link_id,
  }));
}

// Author a waypoint. Takes a client (seed-map applies a whole spec in one
// transaction) rather than a pool.
//
// Conflict target is the TILE expression index, not (world_id, x, y): two rows
// in one tile are not two waypoints, since only one of them could ever be
// walked onto. Re-applying an unchanged spec therefore rewrites the same row.
async function upsertWaypoint(client, { worldId, x, y, name, mapLinkId = null }) {
  const r = await client.query(
    `INSERT INTO waypoints (world_id, x, y, name, map_link_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (world_id, floor(y / 100), floor(x / 100))
       DO UPDATE SET name = EXCLUDED.name, map_link_id = EXCLUDED.map_link_id,
                     x = EXCLUDED.x, y = EXCLUDED.y
     RETURNING id`,
    [worldId, x, y, name, mapLinkId],
  );
  return { id: r.rows[0].id };
}

// Light a waypoint for a character. Idempotent BY THE PRIMARY KEY, not by the
// caller remembering: this runs off the authority's tick loop, so it will be
// attempted again after every relog and must never be able to error or
// duplicate.
//
// `firstTime` is the INSERT's own rowCount -- a database fact, not the server's
// memory of one. The client is told which it was so slice F can announce a
// discovery once instead of on every walk-over, and a server that merely
// *thinks* it has seen this before (an in-memory latch, cleared by a restart)
// would get that wrong in exactly the case a player would notice.
async function activateWaypoint(pool, characterId, waypointId) {
  const r = await pool.query(
    `INSERT INTO character_waypoints (character_id, waypoint_id)
     VALUES ($1, $2) ON CONFLICT (character_id, waypoint_id) DO NOTHING`,
    [characterId, waypointId],
  );
  return { firstTime: r.rowCount > 0 };
}

// The read API's whole payload, and the shape slice F's travel popup consumes:
// activated waypoints are its travel targets, unactivated ones are drawn
// distinctly and not selectable, so BOTH have to be in one list.
//
// Scoped by fog of war IN THE QUERY, not in the caller. /api/player/world-map
// withholds an unvisited neighbour's name in SQL for the same reason: a filter
// applied in the component still ships the data to the browser, where the
// network tab shows it to anyone who looks. A waypoint the character has never
// been near is a place it has not discovered.
//
// The `OR activated` half is not redundant with "visited". A visit row can be
// lost -- SOMET-265 wiped them, and joinPolicy still carries the workaround --
// and losing one must not un-light a waypoint this character demonstrably stood
// on. Activation is the stronger evidence of the two.
async function listWaypointsForCharacter(pool, characterId) {
  const r = await pool.query(
    `SELECT wp.id, wp.world_id, w.name AS world_name, wp.x, wp.y, wp.name,
            wp.map_link_id, cw.activated_at
       FROM waypoints wp
       JOIN worlds w ON w.id = wp.world_id
       LEFT JOIN character_waypoints cw
              ON cw.waypoint_id = wp.id AND cw.character_id = $1
      WHERE cw.character_id IS NOT NULL
         OR EXISTS (SELECT 1 FROM character_visited_worlds v
                     WHERE v.character_id = $1 AND v.world_id = wp.world_id)
      ORDER BY w.name ASC, wp.name ASC`,
    [characterId],
  );
  return r.rows.map((w) => ({
    id: w.id,
    worldId: w.world_id,
    worldName: w.world_name,
    x: Number(w.x),
    y: Number(w.y),
    name: w.name,
    mapLinkId: w.map_link_id,
    activated: w.activated_at != null,
    activatedAt: w.activated_at,
  }));
}

module.exports = {
  fetchWaypoints, upsertWaypoint, activateWaypoint, listWaypointsForCharacter,
  waypointTileKey, MAP_TILE_SIZE,
};
