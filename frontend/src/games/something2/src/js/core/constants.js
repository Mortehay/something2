export const GAME_WIDTH = 1280;
export const GAME_HEIGHT = 720;
export const GRID_SIZE = 40;
export const WORLD_WIDTH = 10000;
export const WORLD_HEIGHT = 10000;

// World logic unit — a tile is MAP_TILE_SIZE world pixels square. All movement
// and collision run in this world-pixel space. Do not change without auditing
// Player.update / Map.getTileAt.
export const MAP_TILE_SIZE = 100;
// SOMET-788. Half-size of the centred square a (non-solid) blocking decoration
// blocks: 17 -> a 34 px core. Wider than the player footprint's corner spacing
// (so it cannot slip between the corners and "glue" the player), yet a rock
// beside a wall still leaves a 33 px lane for the 32 px footprint. Must match
// backend authority/collision.js DECO_CORE_HALF (see the comment there).
export const DECO_CORE_HALF = 17;

// Isometric render footprint — a world tile projects to a 2:1 diamond this size
// on screen. Rendering only; world logic never uses these.
export const ISO_TILE_W = 128;
export const ISO_TILE_H = 64;

// Effective player speed used by the authoritative sim (Player.speed * speedMultiplier).
export const PLAYER_SPEED_EFFECTIVE = 200;