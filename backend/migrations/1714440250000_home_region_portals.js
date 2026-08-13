/* eslint-disable camelcase */

// Home-region portals (SOMET-299).
//
// A player standing in the starting village could not find a portal, because
// there was none to find: all fourteen live `edge='PORTAL'` rows sit in deep
// dungeon chains (Abyss, Catacombs, Underdeep, Emberhive, Frozen Vaults,
// Crystal Foundry, Ossuary Depths, Umbral Gate). This puts a portal pad outside
// every home-region village gate.
//
// ---------------------------------------------------------------------------
// WHY THREE OF THE FOUR PAIRS LIVE HERE AND NOT IN A MAP SPEC
//
// The home region spans TWO specs. Old Trailhead and Windwatch Pass are
// `spine-descent` worlds; Thornbriar Reach is a `hub-vale` world. A spec link
// resolves `from`/`to` against world KEYS within that same spec
// (seeds/mapSpec.js), so a cross-spec portal cannot be expressed there at all.
//
// This is not new, and not a workaround invented here:
// 1714440201000_home_region_content.js already records that the Old Trailhead
// <-> Thornbriar compass link "exists only in the live database and is in no
// checked-in spec". Same region, same reason, same remedy.
//
// So the split is:
//   - Old Trailhead <-> Windwatch Pass  -> spine-descent.map.json (both are
//     spine-descent worlds, so seed-map converges on it)
//   - the other three pairs             -> HERE
//
// A re-seed does NOT undo this. seed-map only ever upserts links (setPortalLink
// at scripts/seed-map.js:246) and holds no DELETE against map_links anywhere, so
// portal rows it does not declare survive it untouched. Verified before relying
// on it, because the opposite would have made this migration self-erasing.
//
// LITERALS, not a read of the spec files, for the frozen-history reason
// 1714440173000 and 1714440201000 both state: a migration must do the same
// thing forever, and a later spec edit must not silently rewrite what this
// already applied. Worlds are matched BY NAME (worlds_name_unique, migration
// 1714440037000).
//
// ---------------------------------------------------------------------------
// WHY EACH ROW IS WHERE IT IS
//
// Every pad sits two rows SOUTH of its village box, because all three home
// villages gate south (villages.gate_edge = 'S'). Inside the walls would put a
// teleport pad where the merchant and the two gate guards already stand.
//
// The gate column is deliberately AVOIDED. villageGatePoint (mapService.js:914)
// puts an S gate at minCol + floor(width/2) -- column 33, 31 and 41 for the
// three villages -- and the generator carves the road out of the gate down that
// same column. A portal ON it would teleport a player the instant they walked
// out of their own village, which is a trap rather than a feature.
//
// Every coordinate below was checked against the REAL generator (generateRegion
// through buildWorldGenConfig) and lands on a walkable tile.
//
//   Old Trailhead    box cols 30-35 rows 31-34, gate col 33 -> pad row 36
//   Thornbriar Reach box cols 28-33 rows 25-28, gate col 31 -> pad row 30
//   Windwatch Pass   box cols 38-43 rows 24-27, gate col 41 -> pad row 29
//   Catacombs Entry  return tile at col 30 row 33 (walkable rock)
//
// ---------------------------------------------------------------------------
// ONE ENTRY WRITES TWO ROWS. setPortalLink writes the forward row AND its
// mirror, so the three pairs below are six map_links rows, and the spec's single
// entry is the other two -- eight in total.
//
// NONE of these is flagged is_waypoint and none is guarded. The load-bearing
// rule from the home-region spec §5 -- a portal a creature guards may never be a
// waypoint -- is therefore not engaged here, but it still binds whoever adds a
// guard to one of these later, and guardedWaypointViolations pins it over live
// rows.

const { setPortalLink, clearPortalLink } = require('../src/services/mapLinks');

// [fromWorld, fromX, fromY, toWorld, toX, toY]
// Arrival is the COUNTERPART tile -- the portal that leads back. The authority
// latches `_lastPortalTile` on any doorway-style arrival (authority/server.js),
// so landing on a portal tile does not immediately re-warp the traveller.
const PORTALS = [
  // Old Trailhead <-> Windwatch Pass. ALSO declared in spine-descent.map.json,
  // and deliberately duplicated here rather than left to the spec alone.
  //
  // The spec is its declarative home -- both worlds are spine-descent worlds, so
  // a fresh seed must produce it. But seed-map only runs when someone runs it,
  // and no existing database would ever grow this row from a spec edit alone.
  // 1714440201000 states the rule for this exact region: the spec and the
  // migration "must move together or they drift".
  //
  // The duplication is safe, not merely tolerable: setPortalLink upserts on
  // (from_world_id, from_x, from_y) WHERE edge = 'PORTAL', so whichever route
  // runs second converges on the identical row instead of conflicting. The
  // coordinates here and in the spec file are the same four numbers, and
  // home_region_portals_db.test.js asserts the live row, so a divergence between
  // them fails there rather than sitting undetected.
  ['Old Trailhead', 3550, 3650, 'Windwatch Pass', 3950, 2950],
  // Old Trailhead <-> Thornbriar Reach
  ['Old Trailhead', 3150, 3650, 'Thornbriar Reach', 2850, 3050],
  // Thornbriar Reach <-> Windwatch Pass. THE GENUINELY NEW CONNECTION: today
  // those two are linked only through Old Trailhead, with no direct compass edge.
  ['Thornbriar Reach', 3350, 3050, 'Windwatch Pass', 4350, 2950],
  // Old Trailhead <-> The Catacombs: Entry -- the starter dungeon. Band 1-5
  // against Old Trailhead's 1-2. This bypasses no gating (Catacombs Entry is
  // already reachable through Highlands Reach, band 1-8); it does put a level-1
  // character one step from level-5 creatures, which is a tuning question about
  // the DESTINATION, not about the portal.
  ['Old Trailhead', 3750, 3650, 'The Catacombs: Entry', 3050, 3350],
];

async function worldIdByName(pgm, name) {
  const r = await pgm.db.query('SELECT id FROM worlds WHERE name = $1', [name]);
  return r.rows.length ? r.rows[0].id : null;
}

exports.up = async (pgm) => {
  for (const [fromName, fx, fy, toName, tx, ty] of PORTALS) {
    const from = await worldIdByName(pgm, fromName);
    const to = await worldIdByName(pgm, toName);
    // A database without these worlds is a legitimate state (a fresh one seeded
    // from a different map spec). Skip rather than fail: this migration must be
    // applicable to every database, not only the dev one it was written against.
    if (!from || !to) {
      console.log(`home-region portals: skipping ${fromName} -> ${toName} (world missing)`);
      continue;
    }
    await setPortalLink(pgm.db, from, fx, fy, to, tx, ty);
  }
};

exports.down = async (pgm) => {
  // clearPortalLink deletes the source row AND its mirror, keyed by the exact
  // source tile -- the same pairing up() created, so down() removes exactly what
  // up() added and nothing a neighbouring migration owns.
  for (const [fromName, fx, fy] of PORTALS) {
    const from = await worldIdByName(pgm, fromName);
    if (!from) continue;
    await clearPortalLink(pgm.db, from, fx, fy);
  }
};
