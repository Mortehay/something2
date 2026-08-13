// The waypoint network (SOMET-292). One reader, one writer, one activator, one
// list -- everything that touches the `waypoints` / `character_waypoints`
// tables goes through here.
//
// That is not tidiness. This repo's recorded failure (SOMET-249) is a feature
// written by one loader and read by another that never sees it: green tests,
// dead feature. A waypoint has exactly one runtime reader (fetchWaypoints, from
// the authority's loadWorld) and exactly one authoring writer (upsertWaypoint /
// pruneWaypoints, from seed-map.js), so there is no second path for the two to
// disagree on -- and guardedWaypointViolations, the rule that keeps a waypoint
// off a guarded staircase, asks the same table the reader reads.

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
// IDENTITY IS THE NAME, not the tile. `name` is globally UNIQUE and is what the
// travel list shows, so it is the only field that survives an author moving a
// waypoint -- and moving one is the edit slice B makes constantly while it lays
// out the home region. Conflicting on the tile instead (the first shape of this
// function) meant a moved waypoint INSERTed, collided on waypoints_name_unique,
// and rolled the whole applyMapSpec transaction back with a raw 23505; keying on
// the name makes that same edit an UPDATE of the row the players already
// activated, so `character_waypoints` survives the move untouched.
//
// The tile index is still the invariant the runtime needs (two rows in one tile
// means one of them can never be walked onto), so it stays -- as a backstop,
// pre-checked here rather than left to raise 23505 from the INSERT. Same for the
// one-waypoint-per-staircase index. The pre-check is a whole extra round trip
// per waypoint, which is affordable: a spec authors a handful, once, offline.
async function upsertWaypoint(client, { worldId, x, y, name, mapLinkId = null }) {
  const clash = await client.query(
    `SELECT name,
            (world_id = $1 AND floor(y / 100) = floor($3 / 100)
                           AND floor(x / 100) = floor($2 / 100)) AS on_tile
       FROM waypoints
      WHERE name <> $4
        AND ((world_id = $1 AND floor(y / 100) = floor($3 / 100)
                             AND floor(x / 100) = floor($2 / 100))
             OR ($5::uuid IS NOT NULL AND map_link_id = $5))
      LIMIT 1`,
    [worldId, x, y, name, mapLinkId],
  );
  if (clash.rowCount) {
    const other = clash.rows[0];
    throw new Error(other.on_tile
      // Two authored waypoints on one tile are already rejected by
      // validateMapSpec, so reaching this means the occupant is a row the spec
      // no longer authors, or a pair mid-swap: A moving onto B's tile while B
      // has not moved off it yet. Nothing can reorder that away (the tile index
      // is not deferrable), so name the cause and the way out.
      ? `waypoint "${name}" cannot take tile (${Math.floor(y / MAP_TILE_SIZE)},`
        + `${Math.floor(x / MAP_TILE_SIZE)}) -- waypoint "${other.name}" already occupies it, and only `
        + 'one waypoint per tile can ever be walked onto. If two waypoints are swapping tiles, '
        + 'move one to a free tile and seed, then swap.'
      : `waypoint "${name}" cannot take the staircase already backing waypoint "${other.name}" `
        + '-- one registry row per portal link');
  }
  const r = await client.query(
    `INSERT INTO waypoints (world_id, x, y, name, map_link_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (name)
       DO UPDATE SET world_id = EXCLUDED.world_id, map_link_id = EXCLUDED.map_link_id,
                     x = EXCLUDED.x, y = EXCLUDED.y
     RETURNING id`,
    [worldId, x, y, name, mapLinkId],
  );
  return { id: r.rows[0].id };
}

// Convergence, scoped to the worlds one spec owns: drop every waypoint the spec
// no longer authors. Returns what it removed, so the applier can report it.
//
// THIS DELETES `character_waypoints` ROWS (they cascade), and that is the
// deliberate part. The migration's ON DELETE SET NULL exists so an INCIDENTAL
// event -- relinking a staircase -- cannot take a waypoint and its activations
// down with it. De-authoring is not incidental: the map author removed the
// waypoint, so the place is gone from the game and an activation of it is a
// dangling reference, not progress. Seeded worlds already converge this way for
// creatures (populateWorld deletes and re-places) and clear-maps says the same
// thing louder. The alternative -- never deleting -- is what left a waypoint on
// a staircase that a later spec put a guard on: the runtime reads this table,
// not the spec, so a row nothing authors any more is exactly the bypass this
// slice exists to prevent.
//
// Scoped by world, not global: a spec owns its worlds the same way it owns their
// creatures, and another spec's waypoints live in another spec's worlds.
async function pruneWaypoints(client, worldIds, keepNames) {
  const r = await client.query(
    `DELETE FROM waypoints
      WHERE world_id = ANY($1::uuid[]) AND name <> ALL($2::text[])
      RETURNING name`,
    [worldIds, keepNames],
  );
  return r.rows.map((x) => x.name);
}

// Waypoint names are globally unique, so authoring a name that already exists in
// a world this spec does NOT own would silently drag that row across (the upsert
// above sets world_id). Reported instead: a name collision between two specs is
// an authoring mistake, and moving someone else's waypoint is a strange way to
// find out about it.
async function foreignWaypointNames(client, worldIds, names) {
  const r = await client.query(
    `SELECT wp.name, w.name AS world_name
       FROM waypoints wp JOIN worlds w ON w.id = wp.world_id
      WHERE wp.name = ANY($2::text[]) AND wp.world_id <> ALL($1::uuid[])`,
    [worldIds, names],
  );
  return r.rows;
}

// THE LOAD-BEARING RULE, asked of the DATABASE (SOMET-292, home-region spec §5):
// no waypoint may sit on a portal a creature guards.
//
// validateMapSpec enforces the same rule, but it can only read the spec text --
// and two ordinary edits, each clean to the validator, still produce the bypass:
// a spec that adds `guard:` to a portal it previously flagged (the flag goes
// away, the registry row does not), and a spec that drops `guard:` while adding
// the flag (the guard creatures are never deleted -- worldPopulation spares
// `blocks_portal_id IS NOT NULL`). The runtime reads THIS TABLE, so this is
// where the rule has to hold.
//
// All three spellings of the bypass, because the runtime would honour any of
// them: the registry row pointing at the guarded link, a standalone row dropped
// on the staircase's own tile, and the authored flag itself.
//
// BOTH SIDES of a guarded staircase, too. setPortalLink writes two rows and
// insertPortalGuards defends only the departure side, so a waypoint on the
// arrival row drops a traveller past the guard -- the same bypass, backwards.
// The mirror is found structurally (its from_* is the forward row's to_*),
// which is the only handle there is: nothing stores the pairing.
//
// worldIds scopes the scan to one spec's worlds; pass null to sweep everything.
const GUARDED_STAIRCASES = `
  WITH guarded AS (
    SELECT ml.id, ml.from_world_id, ml.from_x, ml.from_y,
           ml.to_world_id, ml.to_x, ml.to_y,
           string_agg(DISTINCT wc.type, ', ') AS guards
      FROM map_links ml
      JOIN world_creatures wc ON wc.blocks_portal_id = ml.id
     GROUP BY ml.id
  ),
  staircase AS (
    SELECT id, from_world_id, from_x, from_y, guards FROM guarded
    UNION ALL
    SELECT m.id, m.from_world_id, m.from_x, m.from_y, g.guards || ' (arrival side)'
      FROM map_links m
      JOIN guarded g ON m.edge = 'PORTAL' AND m.from_world_id = g.to_world_id
                    AND m.from_x = g.to_x AND m.from_y = g.to_y
  )`;

async function guardedWaypointViolations(client, worldIds = null) {
  const r = await client.query(`${GUARDED_STAIRCASES}
    SELECT wp.name AS waypoint, w.name AS world, s.guards,
           'its registry row points at the guarded link' AS how
      FROM waypoints wp
      JOIN worlds w ON w.id = wp.world_id
      JOIN staircase s ON s.id = wp.map_link_id
     WHERE $1::uuid[] IS NULL OR wp.world_id = ANY($1)
    UNION ALL
    SELECT wp.name, w.name, s.guards, 'it sits on the guarded staircase tile'
      FROM waypoints wp
      JOIN worlds w ON w.id = wp.world_id
      JOIN staircase s ON s.from_world_id = wp.world_id
                      AND floor(s.from_x / 100) = floor(wp.x / 100)
                      AND floor(s.from_y / 100) = floor(wp.y / 100)
     WHERE $1::uuid[] IS NULL OR wp.world_id = ANY($1)
    UNION ALL
    SELECT format('(the link at %s,%s)', floor(ml.from_y / 100), floor(ml.from_x / 100)),
           w.name, s.guards, 'map_links.is_waypoint is set on it'
      FROM map_links ml
      JOIN staircase s ON s.id = ml.id
      JOIN worlds w ON w.id = ml.from_world_id
     WHERE ml.is_waypoint AND ($1::uuid[] IS NULL OR ml.from_world_id = ANY($1))`,
  [worldIds]);
  return r.rows;
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
  pruneWaypoints, foreignWaypointNames, guardedWaypointViolations,
  waypointTileKey, MAP_TILE_SIZE,
};
