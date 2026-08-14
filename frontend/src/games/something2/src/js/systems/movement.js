// Map-agnostic movement/collision resolution. Delegates walkability + speed to
// the map (ChunkedMap: isWalkable / speedAt), so an unloaded chunk blocks
// movement (streaming frontier). Pure: returns a new {x,y,moved}, never mutates
// the actor. No world-bounds clamp (infinite world) and no entity collision
// (Phase 5). Mirrors the per-axis tile logic of the legacy Player.update.
import { MAP_TILE_SIZE } from "../core/constants.js";

const WALL_EPS = 0.01; // clamp/inset margin so a clamped face stays inside the walkable tile

// SOMET-337. Fraction of the actor's box used as its ground FOOTPRINT — the
// feet, not the whole body. The box is the SPRITE's extent (player 64x64,
// creature 48x48); using all of it against a 100px tile stopped an actor half
// a box-width from the obstacle (32px for a player), a gap that became visible
// once SOMET-319 put the feet on the real anchor. At 0.5 the standoff halves:
// 16px for a player, 12px for a creature.
//
// Scale, not a fixed size, so one rule covers every actor and 1.0 reproduces
// the old full-box behaviour exactly. The anchor is unchanged — the footprint
// is centred on the same box centre movement already resolved against.
const FOOTPRINT_SCALE = 0.5;

export function resolveMove(map, actor, dirX, dirY, dt) {
  if (dirX === 0 && dirY === 0) return { x: actor.x, y: actor.y, moved: false };

  const len = Math.hypot(dirX, dirY);
  const nx = dirX / len;
  const ny = dirY / len;

  const hw = actor.width / 2;
  const hh = actor.height / 2;
  const cx = actor.x + hw;
  const cy = actor.y + hh;

  // Footprint half-extents — what the walkability samples and the swept clamp
  // read. hw/hh stay the SPRITE box (still the anchor's basis); fhw/fhh are the
  // feet. With FOOTPRINT_SCALE = 1 these are equal and the maths is identical
  // to the pre-SOMET-337 full-box test.
  const fhw = hw * FOOTPRINT_SCALE;
  const fhh = hh * FOOTPRINT_SCALE;

  const tileSpeed = map.speedAt(cx, cy);
  const stepX = nx * actor.speed * dt * tileSpeed;
  const stepY = ny * actor.speed * dt * tileSpeed;

  let x = actor.x;
  let y = actor.y;
  let moved = false;

  // Swept clamp per axis. The leading face is the box edge in the travel
  // direction; a sub-tile step crosses at most one boundary.
  // Assumes tile-aligned walls (isWalkable is per-tile) and sub-tile steps (dt small); both hold in-game.
  // If the destination corners are blocked, clamp the face to WALL_EPS shy of the
  // wall boundary and move only that far (dt-invariant: any timestep lands on
  // the same face). Perpendicular corners are inset by WALL_EPS so an edge
  // exactly on a tile line is not read as inside the next tile.
  if (stepX !== 0) {
    const dir = stepX > 0 ? 1 : -1;
    const face = cx + dir * fhw;
    const destFace = face + stepX;
    const top = cy - fhh + WALL_EPS;
    const bot = cy + fhh - WALL_EPS;
    if (map.isWalkable(destFace, top) && map.isWalkable(destFace, bot)) {
      x += stepX;
      moved = true;
    } else {
      const boundary = dir > 0
        ? Math.floor(destFace / MAP_TILE_SIZE) * MAP_TILE_SIZE
        : Math.ceil(destFace / MAP_TILE_SIZE) * MAP_TILE_SIZE;
      const move = (boundary - dir * WALL_EPS) - face;
      if (move * dir > 0) {
        x += move;
        moved = true;
      }
    }
  }
  if (stepY !== 0) {
    const dir = stepY > 0 ? 1 : -1;
    const face = cy + dir * fhh;
    const destFace = face + stepY;
    const left = cx - fhw + WALL_EPS;
    const right = cx + fhw - WALL_EPS;
    if (map.isWalkable(left, destFace) && map.isWalkable(right, destFace)) {
      y += stepY;
      moved = true;
    } else {
      const boundary = dir > 0
        ? Math.floor(destFace / MAP_TILE_SIZE) * MAP_TILE_SIZE
        : Math.ceil(destFace / MAP_TILE_SIZE) * MAP_TILE_SIZE;
      const move = (boundary - dir * WALL_EPS) - face;
      if (move * dir > 0) {
        y += move;
        moved = true;
      }
    }
  }

  return { x, y, moved };
}
