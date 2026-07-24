// Which world the player should be auto-joined into on load, or null for
// "not yet / never". Pulled out of Something2.jsx's effect so the rule is
// testable: the component itself can't be rendered in this suite (no DOM
// testing library), and this is the one piece with real branching.

// The world assets initChunked needs up front. Both arrive from their own
// queries, in parallel with the world list, so "worlds resolved" says nothing
// about whether these have.
//
// Joining without them is not a transient blank frame that fixes itself — the
// values are read ONCE at join time: tileTypes builds the ChunkedMap and
// entityTypes is handed to CreatureManager and preloadSprites. A join that
// wins the race against /api/map/config therefore renders untextured ground
// and colored boxes for the rest of the session, with nothing to re-trigger
// the load. Waiting a few extra milliseconds is the whole fix.
export function worldAssetsReady(mapTiles, mapConfig) {
  return !!mapTiles && !!mapConfig;
}

// Prefer the world flagged `is_entry` (Linked Maps); fall back to the
// migration-seeded world named "Overworld" (lowest id if test duplicates
// exist) for worlds without an entry flag set.
export function pickEntryWorld(worlds) {
  if (!Array.isArray(worlds) || worlds.length === 0) return null;
  const entry = worlds.find(w => w.is_entry);
  if (entry) return entry;
  return worlds
    .filter(w => w.name === 'Overworld')
    .sort((a, b) => a.id - b.id)[0] || null;
}

// The full auto-join decision. Returns the world id to join, or null.
export function autoJoinTarget({ isAdmin, isPlaying, alreadyJoined, hasGame, worlds, mapTiles, mapConfig }) {
  if (isAdmin || isPlaying || alreadyJoined) return null;
  if (!hasGame) return null;
  if (!worldAssetsReady(mapTiles, mapConfig)) return null;
  const target = pickEntryWorld(worlds);
  return target ? target.id : null;
}
