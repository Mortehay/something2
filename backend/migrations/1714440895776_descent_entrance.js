/* eslint-disable camelcase */

// The entrance to the Descent (the Catacombs, Underdeep, Ossuary Depths, Emberhive, Frozen Vaults,
// Crystal Foundry, Umbral Gate, Abyss and the Reach / Frontier surface worlds).
//
// 66 of the 165 worlds could not be reached by anyone. Their only way in was the Old Trailhead ->
// The Catacombs: Entry portal that 1714440250000 added and 1714440260000 removed along with the
// other home-village pads (SOMET-300), so the whole cluster -- every dungeon boss that is not on the
// Spire, three hub villages and the quests that point at them (explore_catacombs, explore_underdeep,
// explore_ossuary, explore_emberhive) -- was cut off from the entry world.
//
// SOMET-300 was right about the pads and the removal stands: no walk-through portal touches a home
// village world (home_region_portals_db.test.js holds that). The way in is a DUNGEON portal at the
// hub instead, beside the Spire's: Vale Crossing is where the large dungeons attach (the Spire at
// (5850,4350), the boss arenas at (5450,5250)).
//
// Also declared in seeds/maps/p5-descent.map.json (`@Vale Crossing`), so a fresh seed produces it;
// this migration is for databases that already exist. setPortalLink upserts on
// (from_world_id, from_x, from_y), so either route converges on the same row.

const { setPortalLink, clearPortalLink } = require('../src/services/mapLinks');

// [fromWorld, fromX, fromY, toWorld, toX, toY]. The portal tile is carved by the map generator
// (mapService.portalTileCells), so any in-bounds tile works.
const PORTALS = [
  ['The Catacombs: Entry', 3050, 3350, 'Vale Crossing', 5850, 4550],
];

async function worldIdByName(pgm, name) {
  const r = await pgm.db.query('SELECT id FROM worlds WHERE name = $1', [name]);
  return r.rows.length ? r.rows[0].id : null;
}

exports.up = async (pgm) => {
  for (const [fromName, fx, fy, toName, tx, ty] of PORTALS) {
    const from = await worldIdByName(pgm, fromName);
    const to = await worldIdByName(pgm, toName);
    // A database without these worlds is a legitimate state (a fresh one seeded from other specs).
    if (!from || !to) {
      console.log(`descent entrance: skipping ${fromName} -> ${toName} (world missing)`);
      continue;
    }
    await setPortalLink(pgm.db, from, fx, fy, to, tx, ty);
  }
};

exports.down = async (pgm) => {
  for (const [fromName, fx, fy] of PORTALS) {
    const from = await worldIdByName(pgm, fromName);
    if (!from) continue;
    await clearPortalLink(pgm.db, from, fx, fy);
  }
};
