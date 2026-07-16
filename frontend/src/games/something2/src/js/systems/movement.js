// Map-agnostic movement/collision resolution. Delegates walkability + speed to
// the map (ChunkedMap: isWalkable / speedAt), so an unloaded chunk blocks
// movement (streaming frontier). Pure: returns a new {x,y,moved}, never mutates
// the actor. No world-bounds clamp (infinite world) and no entity collision
// (Phase 5). Mirrors the per-axis tile logic of the legacy Player.update.
export function resolveMove(map, actor, dirX, dirY, dt) {
  if (dirX === 0 && dirY === 0) return { x: actor.x, y: actor.y, moved: false };

  // Normalize so diagonal isn't faster.
  const len = Math.hypot(dirX, dirY);
  const nx = dirX / len;
  const ny = dirY / len;

  const cx = actor.x + actor.width / 2;
  const cy = actor.y + actor.height / 2;

  const tileSpeed = map.speedAt(cx, cy);
  const stepX = nx * actor.speed * dt * tileSpeed;
  const stepY = ny * actor.speed * dt * tileSpeed;

  let x = actor.x;
  let y = actor.y;
  let moved = false;

  // Test each axis independently at the (moved) center.
  if (stepX !== 0 && map.isWalkable(cx + stepX, cy)) {
    x += stepX;
    moved = true;
  }
  if (stepY !== 0 && map.isWalkable(cx, cy + stepY)) {
    y += stepY;
    moved = true;
  }

  return { x, y, moved };
}
