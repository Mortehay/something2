// The displacement primitive: push an object away from an origin point,
// wall-aware. Extracted verbatim from authority/server.js:142 (SOMET-243's
// blocked-portal bounce), renaming only `portalX`/`portalY` to `fromX`/`fromY`
// -- the portal path still calls this with the same arguments and gets the
// same result. Its behaviour must not change: the portal bounce is not this
// module's business.
//
// Pushes the player further along the same line they approached the portal
// on (portal -> player, extended), so it reads as "bounced off the door"
// rather than a random shove. Falls back to leaving the player exactly
// where they are if the candidate tile is not walkable -- never teleports
// someone into a wall.
//
// All-or-nothing by design: a candidate that is not walkable yields no move
// at all, so nothing is ever displaced into geometry.
function knockbackPosition({ px, py, fromX, fromY, distance, map }) {
  let dx = px - fromX;
  let dy = py - fromY;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) { dx = 0; dy = -1; } // degenerate: player exactly on the portal, push north arbitrarily
  else { dx /= len; dy /= len; }
  const candidateX = px + dx * distance;
  const candidateY = py + dy * distance;
  if (!map.isWalkable(candidateX, candidateY)) return { x: px, y: py };
  return { x: candidateX, y: candidateY };
}

// Combat knockback. Tries the full distance, then half, then a quarter,
// taking the first that lands somewhere walkable.
//
// The portal bounce deliberately does NOT use this: it fires once per bump and
// changing its feel is out of scope. Combat knockback fires constantly, and
// without the retry a target standing against a wall absorbs the shove
// entirely -- which reads as the mechanic being broken rather than as terrain
// working.
function knockbackWithFallback({ px, py, fromX, fromY, distance, map }) {
  for (const d of [distance, distance / 2, distance / 4]) {
    const r = knockbackPosition({ px, py, fromX, fromY, distance: d, map });
    if (r.x !== px || r.y !== py) return r;
  }
  return { x: px, y: py };
}

module.exports = { knockbackPosition, knockbackWithFallback };
