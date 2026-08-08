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

// Shove a surviving target (player OR creature -- both carry
// x/y/width/height) away from (fromX, fromY): a creature's attacker, an
// AoE blast centre, or a projectile's own position at the moment of impact.
//
// SOMET-253 whole-branch review, Fix 3: this was two near-identical
// wrappers -- applyKnockback (authority/creatures.js) and shoveTarget
// (authority/projectiles.js) -- each doing center(target) ->
// knockbackWithFallback -> write target.x/y. That duplication was accepted
// while each had exactly one consumer in its own module; Task 9 added a
// third, authority/world.js's player-vs-player loop, reaching across a
// module boundary for pure geometry that has nothing to do with creatures.
// One implementation now lives where "displace a thing away from a point"
// belongs, alongside knockbackPosition/knockbackWithFallback.
//
// Callers are responsible for only invoking this on a SURVIVOR (hp > 0
// after damage lands -- shoving a corpse moves something the sim is about
// to remove) and for marking a creature target dirty afterward (a player
// target needs no such flag; every player position is broadcast every tick
// regardless).
function shoveAwayFrom(map, fromX, fromY, target, distance) {
  if (!(distance > 0)) return;
  const half = target.width / 2;
  const cx = target.x + half;
  const cy = target.y + target.height / 2;
  const pushed = knockbackWithFallback({ px: cx, py: cy, fromX, fromY, distance, map });
  target.x = pushed.x - half;
  target.y = pushed.y - target.height / 2;
}

module.exports = { knockbackPosition, knockbackWithFallback, shoveAwayFrom };
