// Map-agnostic movement/collision resolution. Delegates walkability + speed to
// the map (ChunkedMap: isWalkable / speedAt), so an unloaded chunk blocks
// movement (streaming frontier). Pure: returns a new {x,y,moved}, never mutates
// the actor. No world-bounds clamp (infinite world) and no entity collision
// (Phase 5). Mirrors the per-axis tile logic of the legacy Player.update.
export function resolveMove(map, actor, dirX, dirY, dt) {
  if (dirX === 0 && dirY === 0) return { x: actor.x, y: actor.y, moved: false };

  const len = Math.hypot(dirX, dirY);
  const nx = dirX / len;
  const ny = dirY / len;

  const hw = actor.width / 2;
  const hh = actor.height / 2;
  const cx = actor.x + hw;
  const cy = actor.y + hh;

  const tileSpeed = map.speedAt(cx, cy);
  const stepX = nx * actor.speed * dt * tileSpeed;
  const stepY = ny * actor.speed * dt * tileSpeed;

  let x = actor.x;
  let y = actor.y;
  let moved = false;

  // Footprint collision: block a step only if the box's LEADING EDGE in the
  // step direction would enter an unwalkable tile. Test the edge's two corners
  // (the box is <= a tile wide, so 2 corners cover every tile it can touch).
  // Testing only the leading edge — not the whole box — lets an actor already
  // overlapping a wall still move away from it.
  if (stepX !== 0) {
    const leadX = cx + stepX + (stepX > 0 ? hw : -hw);
    if (map.isWalkable(leadX, cy - hh) && map.isWalkable(leadX, cy + hh)) {
      x += stepX;
      moved = true;
    }
  }
  if (stepY !== 0) {
    const leadY = cy + stepY + (stepY > 0 ? hh : -hh);
    if (map.isWalkable(cx - hw, leadY) && map.isWalkable(cx + hw, leadY)) {
      y += stepY;
      moved = true;
    }
  }

  return { x, y, moved };
}
