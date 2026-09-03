const { chunkOf, CHUNK_KEY, neighborhoodKeys } = require('./coords');

// SOMET-365. Scoping the PLAYER broadcast to the recipient's neighbourhood.
//
// Creature, item and chest broadcasts were already AOI-scoped; players were
// not. World.snapshot() maps every player in the world into one array and the
// tick loop handed that same array to every socket, which meant three things:
//
//   1. bandwidth grew as O(P^2) per world per tick -- every player's row sent
//      to every player, every tick;
//   2. the client's remotePlayers map held everyone in the world, and
//      buildDrawables pushed all of them into the per-frame drawables array
//      and SORTED them, including players who can never be visible;
//   3. it handed every client the live position of every player in the world,
//      which is an information disclosure the moment anything is competitive.
//
// WHY TWO FUNCTIONS RATHER THAN A FILTER PER SOCKET. The obvious shape --
// `snap.players.filter(...)` inside the per-socket loop -- is O(P) per
// recipient (so O(P^2) work to fix an O(P^2) bandwidth problem) and, worse,
// a `.map()` there would build a fresh row object per player per recipient.
// The old code shared ONE row object across every socket by reference and that
// property is worth keeping: bucket once per tick, then each recipient's list
// is assembled by pushing references. Only the containing array is per-socket.
// See playerAoi.test.js, which asserts the sharing by reference rather than
// trusting this comment.

// Bucket this tick's player rows by chunk. Called ONCE per tick, per world.
//
// Rows are stored by reference exactly as they arrive; nothing is copied or
// re-shaped, so whatever World.snapshot() decides a player row contains is
// what every recipient gets. That matters because the row is the one place
// this file must not have an opinion -- a snapshot field added later must not
// need a change here to reach the wire (the failure mode SOMET-528 hit twice
// with named field lists).
function bucketPlayersByChunk(players, chunkSize) {
  const buckets = new Map();
  for (const row of players || []) {
    const { cx, cy } = chunkOf(row.x, row.y, chunkSize);
    const key = CHUNK_KEY(cx, cy);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  }
  return buckets;
}

// The rows one recipient at (x, y) should receive: everything in the same
// chunk neighbourhood, plus -- unconditionally -- the recipient's own row.
//
// `ownRow` is not a convenience. The client reconciles its OWN predicted state
// out of the frame (ackSeq, hp, mana, stamina, equipment), so a recipient
// missing from its own frame does not merely fail to draw itself: prediction
// reconciliation stops entirely. Its own chunk is always inside its own
// neighbourhood, so in practice the row is already there and the `includes`
// finds it -- this exists so that a future change to the radius, the bucketing
// or the snapshot cannot quietly break the one row that must never be absent.
// The check is reference identity, which is exactly right here: the row in the
// bucket IS the row passed in.
//
// `radius` mirrors the 1 that recomputeActive, broadcastCreatures and
// broadcastChests all use, and is a parameter so a test can prove the boundary
// rather than restate the constant.
function playersNear(buckets, x, y, chunkSize, ownRow = null, radius = 1) {
  const { cx, cy } = chunkOf(x, y, chunkSize);
  const out = [];
  for (const key of neighborhoodKeys(cx, cy, radius)) {
    const bucket = buckets.get(key);
    if (!bucket) continue;
    for (const row of bucket) out.push(row);
  }
  if (ownRow && !out.includes(ownRow)) out.push(ownRow);
  return out;
}

module.exports = { bucketPlayersByChunk, playersNear };
