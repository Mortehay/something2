import { MAP_TILE_SIZE } from './src/js/core/constants.js';

// When the travel popup should open by itself (SOMET-300).
//
// The reported behaviour is "standing on a portal opens the popup". Taken
// literally that is a modal that reopens on every poll for as long as the player
// stands there, which cannot be closed. So the rule is really "ARRIVING on the
// portal opens it": a transition onto the tile, latched on the previous tile
// rather than on a timer.
//
// Pure and in its own module for the reason waypointTravel.js and
// playerWorldMap.js both are: vitest runs in a node environment in this project,
// so the component cannot be rendered in a test at all. A rule that lives inside
// a useEffect is a rule with no test.

// ROW FIRST, then column. The same order services/waypoints.js keys the tick
// loop's lookup in and waypointTravel.js's own tileKey uses. Those two were once
// transposed relative to each other while each stayed internally consistent --
// the kind of agreement that holds until someone compares them -- so this states
// the convention rather than re-deriving it.
export function portalTileOf(point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  return `${Math.floor(point.y / MAP_TILE_SIZE)},${Math.floor(point.x / MAP_TILE_SIZE)}`;
}

// `portal`   the current world's travel landmark, or null (86 of ~90 have none)
// `worldId`  the world the player is actually in
// `prevTile` the tile they were on at the previous reading; null before the
//            first one is known
// `tile`     the tile they are on now
// `isOpen`   whether the popup is already up
export function shouldAutoOpen({ portal, worldId, prevTile, tile, isOpen } = {}) {
  if (isOpen) return false;                       // never fight a player mid-selection
  if (!portal || !tile) return false;

  // A portal belongs to a world. Two worlds can hold one on the same tile, so
  // matching the tile alone would pop the panel in the wrong place.
  if (portal.worldId != null && worldId != null && portal.worldId !== worldId) return false;

  const portalTile = portalTileOf(portal);
  if (portalTile == null || tile !== portalTile) return false;

  // THE LATCH. Standing still means prevTile === tile, and that must not
  // re-open. Only a transition ONTO the tile counts.
  //
  // prevTile === null means we have not seen this player move yet -- typically
  // the frame right after a join. A player resuming ON the portal must not be
  // handed a modal before touching a key, which is the same situation the
  // authority's own arrival latch exists to handle on the server side.
  if (prevTile == null) return false;

  return prevTile !== tile;
}
