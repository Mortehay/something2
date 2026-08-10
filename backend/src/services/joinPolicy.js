// Who may join which world (SOMET-256 follow-on, Plan B slice 3).
//
// WHY THIS EXISTS AT ALL. Slice 3 adds click-to-travel to the player World Map,
// and the map only offers worlds that are visited AND flagged
// `allows_fast_travel`. That offer is made in the browser, so it is not a
// restriction: the join frame is `{type:'join', world_id, character_id}` over a
// socket the player already holds, and until now the handler asked only "is this
// character yours" and "does this world exist". Any world id -- a band 47-50
// dungeon room behind a portal guard the character has never met -- was a
// successful join. The map feature does not create that hole, but it is the
// first feature whose whole premise is "some worlds are reachable and some are
// not", so the hole has to close with it or the feature is decorative.
//
// The rule is deliberately NOT "the client said fast_travel: true". A forged
// frame simply omits the flag, so an intent-keyed check gates only well-behaved
// clients. The server therefore authorizes EVERY join against facts it owns.
//
// Split into a pure decision + a loader so the rule can be tested exhaustively
// without a socket, a world, or a tick loop.

// Decide a join. `facts` comes from joinPolicyFacts below.
//
// Returns { allowed, reason } -- reason is a stable token for tests and logs,
// never something sent to the client verbatim (the wire message stays generic;
// telling a probe WHICH condition it failed maps out the world graph for it).
function mayJoin({ isAdmin, pendingWorldId, worldId, facts }) {
  // 1. Admins keep the world picker. It is existing tooling that joins
  //    arbitrary worlds by design, and the whole admin surface already trusts
  //    the role. Whether PLAYERS should ever get an unrestricted picker is a
  //    separate question; this is not the place that would answer it.
  if (isAdmin) return { allowed: true, reason: 'admin' };

  if (!facts) return { allowed: false, reason: 'unknown-world' };

  // 2. The server itself authorized this trip. A portal or doorway transition
  //    is decided in the tick loop, which records the destination in
  //    pendingArrivals and tells the client to reconnect; this join IS the
  //    second half of that transition. Checked against server-side state, not
  //    against anything the client sent, so it cannot be forged.
  //
  //    This is also the leg that keeps a legitimate arrival working when the
  //    fire-and-forget recordVisit that runs alongside the transition fails: a
  //    bookkeeping error must not become "you may not enter the room you just
  //    walked into".
  if (pendingWorldId != null && pendingWorldId === worldId) {
    return { allowed: true, reason: 'transition' };
  }

  // 3. Resume. Where the character logged out is always re-enterable, whatever
  //    it is -- the point of SOMET-256 is that you come back where you left.
  //    Deliberately independent of the travel flag: logging out deep in a
  //    dungeon must not strand a character outside it.
  if (facts.lastWorldId != null && facts.lastWorldId === worldId) {
    return { allowed: true, reason: 'resume' };
  }

  // 4. Fast travel. Both halves are required. `visited` alone would let a
  //    character teleport back into any dungeon room it ever walked through,
  //    which is exactly the portal-guard bypass the flag exists to prevent;
  //    `allowsFastTravel` alone would let a character skip to a hub it has
  //    never seen.
  if (facts.visited && facts.allowsFastTravel) {
    return { allowed: true, reason: 'fast-travel' };
  }

  // 5. First join ever. A character with no history has no last world and no
  //    visits, so rules 3 and 4 cannot fire and it would be locked out of the
  //    game entirely. The entry world is the designed answer; a flagged world
  //    is accepted alongside it because `is_entry` has been lost from the live
  //    data before (SOMET-265) and a one-line regression in a seed script must
  //    not make new characters unplayable.
  //
  //    Not a hole: flagged worlds are safe surface locations by construction
  //    (slice 2 flags no dungeon room, and map_spec_fixtures.test.js keeps it
  //    that way), so the worst case is arriving somewhere a walk could also
  //    have reached. And it applies exactly once -- the moment the character
  //    has been anywhere, `hasHistory` is true and this leg is dead.
  if (!facts.hasHistory && (facts.isEntry || facts.allowsFastTravel)) {
    return { allowed: true, reason: 'first-join' };
  }

  return { allowed: false, reason: 'not-reachable' };
}

// One round trip. The three facts are correlated (all keyed on this character)
// and the join path is latency-sensitive, so they are gathered together rather
// than as three awaits.
//
// `last_world` MUST stay byte-for-byte the same shape as the LATERAL subquery in
// services/characters.js -- that one tells the client where to resume, this one
// decides whether the resume is allowed. If they ever disagree about which row
// is "last", the client offers a world the server refuses and the player sits on
// a canvas that never receives `joined`. join_policy_db.test.js pins the pair.
async function joinPolicyFacts(pool, characterId, worldId) {
  const r = await pool.query(
    `SELECT w.is_entry, w.allows_fast_travel,
            EXISTS (SELECT 1 FROM character_visited_worlds v
                     WHERE v.character_id = $2 AND v.world_id = w.id) AS visited,
            EXISTS (SELECT 1 FROM character_visited_worlds v2
                     WHERE v2.character_id = $2) AS visited_any,
            (SELECT wp.world_id FROM world_players wp
              WHERE wp.character_id = $2
              ORDER BY wp.updated_at DESC LIMIT 1) AS last_world
       FROM worlds w WHERE w.id = $1`,
    [worldId, characterId],
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    isEntry: row.is_entry === true,
    allowsFastTravel: row.allows_fast_travel === true,
    visited: row.visited === true,
    // BOTH tables. A character restored from the world_players backfill has
    // history even if its visit rows were never written, and a character that
    // has visited somewhere has history even if its world_players row was
    // cleaned up. Either one closes the first-join allowance.
    hasHistory: row.visited_any === true || row.last_world != null,
    lastWorldId: row.last_world,
  };
}

module.exports = { mayJoin, joinPolicyFacts };
