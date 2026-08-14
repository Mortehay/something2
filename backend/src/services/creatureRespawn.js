// SOMET-309: creature respawn. A death enqueues a creature_respawns row (see
// authority/loot.js); this module drains due rows back into world_creatures.
//
// Deliberately NOT part of worldPopulation.js. That module is wipe-and-refill
// -- it opens by DELETEing every wild creature in a world and places a
// complete fresh set -- which is the opposite lifecycle to incremental top-up,
// and folding a hot per-death path into a seeding module would couple them for
// no gain.

// The delay between a creature dying and its replacement becoming due.
const RESPAWN_DELAY_MS = 30000;

// The sweep's own interval. NOT itemSweepMs, which is 60000: draining a
// 30-second queue on a 60-second timer would make respawns take 30-90s and
// silently undo the pacing this feature was tuned for.
const CREATURE_SWEEP_MS = 10000;

// World px. MAP_TILE_SIZE is 100, so this is 10 tiles. The viewport shows
// roughly 15x15 tiles, so this keeps a spawn off the middle of someone's
// screen without pushing it so far that a cleared area never refills.
const RESPAWN_MIN_PLAYER_DISTANCE = 1000;

// True when no player is closer than minDistance to (x, y).
//
// Compares squared distances so the hot path takes no Math.sqrt. Strictly
// less-than: a player at exactly minDistance does not block the position, so
// the boundary belongs to the spawn.
function isClearOfPlayers(x, y, players, minDistance = RESPAWN_MIN_PLAYER_DISTANCE) {
  const min2 = minDistance * minDistance;
  for (const p of players) {
    const dx = p.x - x;
    const dy = p.y - y;
    if (dx * dx + dy * dy < min2) return false;
  }
  return true;
}

module.exports = {
  isClearOfPlayers,
  RESPAWN_DELAY_MS, CREATURE_SWEEP_MS, RESPAWN_MIN_PLAYER_DISTANCE,
};
