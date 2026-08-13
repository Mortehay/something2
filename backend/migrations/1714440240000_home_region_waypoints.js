// SOMET-293 — the home region's three waypoints, moved into the live database.
//
// WHY A MIGRATION AND NOT A SEED RUN. `seed-map` is the normal way authored map
// content reaches a database, but it is a MANUAL operator command
// (`make seed-map SPEC=<name>`), one spec at a time, that nothing in the deploy
// path runs. A live database converges through migrations or it does not
// converge at all. So the specs gain their `waypoints` blocks -- that is the
// canonical source, and what a later seed run will reproduce -- and the live
// rows are moved here. The same split 1714440175000 used for the entry village
// and 1714440201000 used for slice B's villages, roads and pens.
//
// The hazard that made a seed run from THIS branch actively wrong before it was
// merged with slice B: applyMapSpec re-asserts a world's authored columns
// wholesale on every run (`authored_roads = EXCLUDED.authored_roads`,
// `pens = EXCLUDED.pens`, from `w.roads ?? []`), so a spec file that had not yet
// grown slice B's `roads` and `pens` blocks would have written `[]` over the
// live ones. Villages were never the risk -- applyMapSpec creates them only when
// a world has none and otherwise merely WARNS on a count mismatch; it has no
// path that deletes one. Both specs now carry slice B's blocks, so that
// particular regression is closed; the manual-command argument above is the one
// that survives the merge and is the actual reason this file exists.
//
// WHY IT CALLS APPLICATION CODE. `upsertWaypoint` is the ONE writer for this
// table -- it carries the per-tile and per-staircase clash pre-checks and the
// conflict-on-NAME rule that lets a later spec move a waypoint without
// destroying every character's activation of it. Re-implementing the INSERT here
// would be a second writer, which is the precise thing services/waypoints.js was
// written to prevent. The precedent is 1714440175000 calling createVillage;
// services/waypoints.js has no top-level pool creation, so requiring it from a
// migration is safe.
//
// WHERE THEY ARE. One per home-region village, on the interior tile immediately
// east of the village spawn -- between the spawn and the merchant, so a player
// lights it the first time they walk over to trade. That tile is inside the
// village footprint, so it is walkable by construction (stampVillage paints the
// interior as floor) and inside slice A's safe region, so nothing hostile spawns
// on it. The coordinates are literals here for the frozen-history reason
// 1714440173000 states; tests/home_region_waypoints_db.test.js recomputes the
// placement rule from the live village rows with the real geometry helpers, so a
// wrong literal fails there rather than sitting undetected.
//
// No junction waypoint. Every link between these three worlds is a compass
// doorway, which validateMapSpec rejects as a waypoint outright ("a doorway you
// can walk through is not a shortcut worth a waypoint"). The junction of the
// region is Windwatch Pass -- the only one of the three with four doorways -- so
// its village waypoint already sits on the hub.

exports.shorthands = undefined;

const { upsertWaypoint } = require('../src/services/waypoints.js');

// Keyed by world NAME, because the region spans two map specs (Old Trailhead and
// Windwatch Pass are spine-descent worlds, Thornbriar Reach is a hub-vale one)
// and a gameplay region is not a map file. Same pixel values as the `waypoints`
// blocks in those two specs.
const WAYPOINTS = [
  { world: 'Old Trailhead', name: 'Old Trailhead Commons', x: 3250, y: 3250 },
  { world: 'Windwatch Pass', name: 'Windwatch Waystone', x: 4050, y: 2550 },
  { world: 'Thornbriar Reach', name: 'Thornbriar Green', x: 3050, y: 2650 },
];

exports.up = async (pgm) => {
  for (const wp of WAYPOINTS) {
    const r = await pgm.db.query('SELECT id FROM worlds WHERE name = $1', [wp.world]);
    // A bare or partially-seeded database (CI, a fresh clone) has no worlds yet.
    // Skipping is right rather than throwing: the spec blocks are the canonical
    // source and a later seed-map run authors them anyway. This migration only
    // exists to move a database that is already populated.
    if (r.rows.length === 0) continue;
    // Idempotent through upsertWaypoint's ON CONFLICT (name): a second run
    // updates the row in place rather than inserting a duplicate, and leaves
    // character_waypoints untouched.
    await upsertWaypoint(pgm.db, {
      worldId: r.rows[0].id, x: wp.x, y: wp.y, name: wp.name, mapLinkId: null,
    });
  }
};

exports.down = async (pgm) => {
  // Scoped by name, which is the identity upsertWaypoint uses, so this removes
  // exactly the three rows `up` authored and nothing an operator has added since.
  //
  // THIS CASCADES character_waypoints, and that is correct rather than
  // collateral: rolling this migration back removes the places from the game, so
  // an activation of one is a dangling reference to somewhere that no longer
  // exists. pruneWaypoints in services/waypoints.js takes the same position for
  // the same reason, and states it at length.
  await pgm.db.query('DELETE FROM waypoints WHERE name = ANY($1::text[])',
    [WAYPOINTS.map((w) => w.name)]);
};
