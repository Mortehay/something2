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
export function autoJoinTarget({
  isAdmin, isPlaying, alreadyJoined, hasGame, hasCharacter, lastWorldId, isGameRoute,
  worlds, mapTiles, mapConfig,
}) {
  if (isAdmin || isPlaying || alreadyJoined) return null;
  // Only on the game route. This used to be enforced by ACCIDENT: the Game
  // instance was created in an effect gated on the same route, so `hasGame` was
  // false everywhere else and auto-join could not fire. SOMET-271 removed that
  // gate (a direct load of /game/map left gameRef null forever, which silently
  // broke click-to-travel), and the accident went with it -- auto-join then
  // fired while the player was reading the World Map and, worse, RACED travel:
  // observed live, a click entered Old Trailhead and auto-join dragged the
  // character back to its last world nine seconds later. Resuming into a world
  // is a thing to do when the player is looking at the game, not at a map.
  if (!isGameRoute) return null;
  if (!hasGame) return null;
  // SOMET-260: the authority refuses a join with no character, so firing before
  // one is chosen is a guaranteed error toast rather than a race that sometimes
  // works. Same reasoning as worldAssetsReady below -- wait, don't retry.
  if (!hasCharacter) return null;
  if (!worldAssetsReady(mapTiles, mapConfig)) return null;

  // Where this character actually logged out wins over the entry world.
  // pickEntryWorld answers "where does a BRAND NEW character start", which is
  // not the same question; using it unconditionally is what made "resume where
  // you logged out" restore the right coordinates in the wrong world -- the
  // authority then read world_players for the ENTRY world, so a character that
  // left via a doorway came back somewhere it had not been.
  //
  // Membership-checked against the loaded list: a world deleted from another
  // session since this character last played would otherwise produce a join the
  // server refuses, and a refused join never sends 'joined' -- the client would
  // hang rather than surface an error.
  if (lastWorldId != null && (worlds || []).some((w) => w.id === lastWorldId)) {
    return lastWorldId;
  }

  const target = pickEntryWorld(worlds);
  return target ? target.id : null;
}
