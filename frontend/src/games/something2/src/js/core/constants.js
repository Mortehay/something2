export const GAME_WIDTH = 1280;
export const GAME_HEIGHT = 720;
export const GRID_SIZE = 40;
export const WORLD_WIDTH = 10000;
export const WORLD_HEIGHT = 10000;

// World logic unit — a tile is MAP_TILE_SIZE world pixels square. All movement
// and collision run in this world-pixel space. Do not change without auditing
// Player.update / Map.getTileAt.
export const MAP_TILE_SIZE = 100;

// Isometric render footprint — a world tile projects to a 2:1 diamond this size
// on screen. Rendering only; world logic never uses these.
export const ISO_TILE_W = 128;
export const ISO_TILE_H = 64;