import { MAP_TILE_SIZE } from './src/js/core/constants.js';

// The waypoint travel popup's rules (SOMET-293), as a pure transform over the
// `/api/player/waypoints` payload.
//
// In its own module for the reason playerWorldMap.js is: vitest runs in a node
// environment in this project, so the component cannot be rendered in a test at
// all. Anything worth asserting -- and "an unactivated waypoint is not
// selectable" is the ticket's own acceptance criterion -- has to live somewhere
// importable, or it is not tested.
//
// THIS IS AN OFFER, NOT A GATE. Every rule below is re-derived server-side by
// the `travel` handler against its own copy of the player's position and its own
// read of character_waypoints; see services/joinPolicy.js's waypoint-travel leg.
// The client's copy exists so the popup can grey a row out and say why, which is
// the difference between a disabled control and a broken one.

// Why a row cannot be chosen. Rendered next to it, because an inert row with no
// explanation reads as a bug -- the same lesson the World Map's legend carries.
export const REASON = {
  YOU_ARE_HERE: 'you-are-here',
  NOT_DISCOVERED: 'not-discovered',
  NOT_ON_A_WAYPOINT: 'not-on-a-waypoint',
};

// The tile a point falls in. Byte-for-byte the arithmetic
// services/waypoints.js's waypointTileKey uses (Math.floor(v / 100)) and the
// arithmetic the authority's tick loop applies to the player -- if the two ever
// disagreed the popup would offer a trip the server refuses, or hide one it
// would have allowed.
const tileKey = (x, y) => `${Math.floor(y / MAP_TILE_SIZE)},${Math.floor(x / MAP_TILE_SIZE)}`;

// `playerX`/`playerY` are the player's CENTRE, which is what the authority uses
// too -- a player is a 64px box placed by its top-left corner, so keying on the
// corner would light the wrong tile near a boundary.
export function buildTravelList({ waypoints, currentWorldId, playerX, playerY } = {}) {
  const list = Array.isArray(waypoints) ? waypoints : [];

  // Where the player is standing, if it is a waypoint at all. Scoped to the
  // current world: two waypoints in different worlds can share a tile, and a
  // list that ignored the world would call the player "here" in a place they
  // have never been.
  const here = (currentWorldId != null
      && Number.isFinite(playerX) && Number.isFinite(playerY))
    ? list.find((w) => w.worldId === currentWorldId
        && tileKey(w.x, w.y) === tileKey(playerX, playerY)) || null
    : null;

  // Standing on a waypoint is not enough -- it has to be one this character has
  // lit. Unlit is the transient state between stepping on and the server's
  // activation write landing, and it is also what a character that has never
  // been here sees.
  const standingOnActivated = here != null && here.activated === true;

  // Insertion-ordered, so the endpoint's own ORDER BY (world name, then
  // waypoint name) survives to the screen rather than being re-sorted here into
  // a second, disagreeing order.
  const groups = new Map();
  for (const w of list) {
    const isHere = here != null && w.id === here.id;
    let reason = null;
    if (isHere) reason = REASON.YOU_ARE_HERE;
    // Checked BEFORE the standing rule: "you have not found this place" is the
    // more specific and more useful thing to tell a player, and it stays true
    // whether or not they happen to be on a waypoint right now.
    else if (w.activated !== true) reason = REASON.NOT_DISCOVERED;
    else if (!standingOnActivated) reason = REASON.NOT_ON_A_WAYPOINT;

    if (!groups.has(w.worldId)) {
      groups.set(w.worldId, { worldId: w.worldId, worldName: w.worldName, entries: [] });
    }
    groups.get(w.worldId).entries.push({
      id: w.id,
      name: w.name,
      // Straight off the payload. The popup draws an unactivated waypoint
      // differently rather than hiding it: knowing a place exists and has not
      // been reached is the point of showing it.
      activated: w.activated === true,
      selectable: reason === null,
      reason,
    });
  }

  return { here, standingOnActivated, groups: [...groups.values()] };
}
