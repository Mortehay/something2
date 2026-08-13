/* eslint-disable camelcase */

// Remove the home-region portal pad (SOMET-300). Reverses 1714440250000.
//
// WHY IT IS BEING UNDONE ONE DAY AFTER IT LANDED. 1714440250000 put a pad of
// walk-through portals outside every home village gate. Browser testing showed
// the real defect underneath it: the game had grown TWO mechanics for one idea.
// The waypoint network (SOMET-292/293) already required standing on a landmark,
// already hid undiscovered destinations and already authorised every trip
// server-side in joinPolicy's waypoint-travel leg. The pad was a second,
// competing answer to the same question, and a player reasonably read four
// landmarks in one village as a bug.
//
// SOMET-300 keeps the network and deletes the rival. Walk-through portals remain
// a real thing -- the 14 dungeon-chain rows are untouched -- they are simply not
// a travel network, and none of them belongs in a starting village.
//
// ---------------------------------------------------------------------------
// THIS MIGRATION IS HALF THE CHANGE. The other half is the deletion of the
// `kind: "portal"` entry from seeds/maps/spine-descent.map.json, in the same
// commit.
//
// Deleting rows here while leaving the declaration there would be undone by the
// next `npm run seed:map`: scripts/seed-map.js:246 calls setPortalLink for every
// spec link, setPortalLink UPSERTS, and seed-map holds no DELETE against
// map_links anywhere. The rows would come back with no migration and no commit
// to explain them.
//
// That is the same spec/migration coupling 1714440201000 records for this
// region, running in the opposite direction: "Both must move together or they
// drift."
// ---------------------------------------------------------------------------
//
// FOUR CALLS, EIGHT ROWS. clearPortalLink deletes the source row AND its mirror,
// keyed by the exact source tile -- exactly the pairing setPortalLink created,
// so this removes what 1714440250000 added and nothing a neighbour owns.

const { setPortalLink, clearPortalLink } = require('../src/services/mapLinks');

// The forward direction of each pair, byte-identical to 1714440250000's own
// table. Spelled out rather than imported from that file: a migration must do
// the same thing forever, and importing a neighbour's constant would let a later
// edit there silently change what this one deletes.
//
// [fromWorld, fromX, fromY, toWorld, toX, toY]
const PORTALS = [
  ['Old Trailhead', 3550, 3650, 'Windwatch Pass', 3950, 2950],
  ['Old Trailhead', 3150, 3650, 'Thornbriar Reach', 2850, 3050],
  ['Thornbriar Reach', 3350, 3050, 'Windwatch Pass', 4350, 2950],
  ['Old Trailhead', 3750, 3650, 'The Catacombs: Entry', 3050, 3350],
];

async function worldIdByName(pgm, name) {
  const r = await pgm.db.query('SELECT id FROM worlds WHERE name = $1', [name]);
  return r.rows.length ? r.rows[0].id : null;
}

exports.up = async (pgm) => {
  for (const [fromName, fx, fy] of PORTALS) {
    const from = await worldIdByName(pgm, fromName);
    // A database that never had these worlds is a legitimate state, same as in
    // 1714440250000. Skip rather than fail.
    if (!from) continue;
    await clearPortalLink(pgm.db, from, fx, fy);
  }
};

exports.down = async (pgm) => {
  // Genuinely reversible: re-applies the identical pairs, so `down` here and
  // `up` in 1714440250000 produce the same eight rows.
  for (const [fromName, fx, fy, toName, tx, ty] of PORTALS) {
    const from = await worldIdByName(pgm, fromName);
    const to = await worldIdByName(pgm, toName);
    if (!from || !to) continue;
    await setPortalLink(pgm.db, from, fx, fy, to, tx, ty);
  }
};
