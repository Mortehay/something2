// Who may be in which world, and who may travel there (SOMET-256 follow-on,
// Plan B slice 3; travel added and fast travel retired by SOMET-293).
//
// WHY THIS EXISTS AT ALL. The join frame is `{type:'join', world_id,
// character_id}` over a socket the player already holds, and the handler once
// asked only "is this character yours" and "does this world exist". Any world id
// -- a band 47-50 dungeon room behind a portal guard the character has never met
// -- was a successful join. Whatever the client's UI offers is made in the
// browser and is therefore not a restriction, so the server authorizes EVERY
// join against facts it owns.
//
// The rule is deliberately NOT "the client said it was allowed to". A forged
// frame simply omits whatever a well-behaved client would have sent, so an
// intent-keyed check gates only well-behaved clients. Nothing below reads
// anything that arrived over the wire except the destination itself.
//
// Split into a pure decision + loaders so the rule can be tested exhaustively
// without a socket, a world, or a tick loop.

// Decide a join, or a waypoint trip. `facts` comes from joinPolicyFacts below;
// `travel`, when present, comes from waypointTravelFacts.
//
// `travel` CHANGES THE QUESTION. Absent, this asks "may this character be in
// that world" and the cascade answers. Present, it asks "may this character
// travel there, now" -- and exactly one leg may answer that, because the join
// legs are all wrong for it. `resume` in particular matches the world the
// character is standing IN (its world_players row is the newest one), so a
// travel decided by the cascade would let a player select an unlit waypoint in
// their own world and be teleported onto it -- which is the one thing the
// popup's unactivated state exists to forbid.
//
// Returns { allowed, reason } -- reason is a stable token for tests and logs,
// never something sent to the client verbatim (the wire message stays generic;
// telling a probe WHICH condition it failed maps out the world graph for it).
function mayJoin({ isAdmin, pendingWorldId, worldId, facts, travel = null }) {
  // 1. Admins keep the world picker. It is existing tooling that joins
  //    arbitrary worlds by design, and the whole admin surface already trusts
  //    the role. Whether PLAYERS should ever get an unrestricted picker is a
  //    separate question; this is not the place that would answer it.
  if (isAdmin) return { allowed: true, reason: 'admin' };

  if (!facts) return { allowed: false, reason: 'unknown-world' };

  // 2. Waypoint travel (SOMET-293). The ONLY leg that may answer a travel
  //    request -- see the `travel` note in this function's header for why the
  //    cascade below must not get a look at it.
  //
  //    Both halves are facts the server owns, and neither is anything the client
  //    sent: the frame carries a destination waypoint id and nothing else.
  //    `standingOnActivatedWaypoint` is derived from the player's position in
  //    the authority's own World object, matched against the waypoint Map
  //    loadWorld built, and then checked against character_waypoints;
  //    `destinationActivated` is that same table. A forged frame has no field
  //    that could move either.
  //
  //    "Standing on an unlit waypoint" and "standing on open ground" are one
  //    branch on purpose. They are the same answer to the player -- you cannot
  //    travel from here -- and splitting them would be a second rule to keep in
  //    step with the popup's.
  if (travel) {
    if (travel.standingOnActivatedWaypoint && travel.destinationActivated) {
      return { allowed: true, reason: 'waypoint-travel' };
    }
    return { allowed: false, reason: 'not-reachable' };
  }

  // 3. The server itself authorized this trip. A portal or doorway transition
  //    is decided in the tick loop, which records the destination in
  //    pendingArrivals and tells the client to reconnect; this join IS the
  //    second half of that transition. Checked against server-side state, not
  //    against anything the client sent, so it cannot be forged.
  //
  //    This is also the leg that keeps a legitimate arrival working when the
  //    fire-and-forget recordVisit that runs alongside the transition fails: a
  //    bookkeeping error must not become "you may not enter the room you just
  //    walked into".
  //
  //    It is also the second half of an authorized WAYPOINT trip: the travel
  //    handler writes pendingArrivals and sends `transition`, so the rejoin
  //    lands here. That is the point -- there is one arrival mechanism, not one
  //    per way of setting off.
  if (pendingWorldId != null && pendingWorldId === worldId) {
    return { allowed: true, reason: 'transition' };
  }

  // 4. Resume. Where the character logged out is always re-enterable, whatever
  //    it is -- the point of SOMET-256 is that you come back where you left.
  //    Deliberately independent of the travel flag: logging out deep in a
  //    dungeon must not strand a character outside it.
  if (facts.lastWorldId != null && facts.lastWorldId === worldId) {
    return { allowed: true, reason: 'resume' };
  }

  // RETIRED (SOMET-293): the `fast-travel` leg.
  //
  //   if (facts.visited && facts.allowsFastTravel) return 'fast-travel';
  //
  // It authorized the World Map's click-to-travel, which this slice removes.
  // `allows_fast_travel` survives as DATA -- map authors read it to decide where
  // waypoints belong -- but a flag on a row is no longer a reason to be
  // somewhere. Travel is now leg 2: a place you have physically stood on, lit,
  // and can set off from. `facts.visited` and `facts.allowsFastTravel` are still
  // loaded because `first-join` below reads the flag and because
  // /api/player/world-map reports the visit; nothing else consults either.
  //
  // The risk this carried was stranding a character whose only route home was a
  // map click. It does not: `resume` (leg 4) covers wherever a character logged
  // out, and `first-join` covers one that has never been anywhere. Checked
  // against the live character table before the leg was deleted, and pinned by
  // join_policy.test.js's dungeon-resume case.
  //
  // ONE SHAPE THIS LEG DID COVER AND NOTHING ELSE DOES (SOMET-293 review,
  // finding 3): hasHistory true, lastWorldId null. Such a character matches
  // nothing at all -- `resume` needs the world_players row it does not have,
  // `first-join` is closed by hasHistory, `transition` needs a pending arrival,
  // and `waypoint-travel` only answers a travel frame. Every join is refused,
  // which is a hard lockout rather than a degraded experience: the client has no
  // last world to offer, the entry world is refused too, and the player sits on
  // a canvas that never receives `joined`.
  //
  // It is REACHABLE, if narrowly. recordVisit runs when the server COMMITS a
  // transition, before the rejoin -- so a client that never completes the rejoin
  // owns a visit row for a world it holds no world_players row in. That alone is
  // harmless (the origin world's row is still the newest one). It only becomes
  // this shape if that origin world is later DELETED: both foreign keys are ON
  // DELETE CASCADE, so the delete takes the world_players row and leaves the
  // other visit standing. `make clear-maps` does exactly that.
  //
  // Left as a note and NOT as a new leg, deliberately:
  //   - the state does not exist. A count over the live characters table
  //     (visit row present, no world_players row anywhere) returns 0 of 20; the
  //     5 characters with no world_players row have no visits either, which is
  //     an ordinary new character and is what `first-join` is for.
  //   - the authorization cascade was reviewed as sound across seven attack
  //     shapes. Adding a leg for a state nobody is in trades a proved rule for
  //     an unproved one on speculation.
  // If it is ever hit, the fix is not to bring `fast-travel` back -- it turned a
  // data flag into a reason to be somewhere, which is what this slice removed.
  // It is to let `first-join` answer a character that has NO world_players row
  // anywhere, since such a character is nowhere and the entry world is not a
  // privilege. That needs a fact joinPolicyFacts does not currently load
  // (world_players existence independent of world), so it is a change, not a
  // one-liner, and it should be made against a real occurrence.

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

// The travel half of the facts (SOMET-293). One round trip, for the same
// latency reason joinPolicyFacts gathers three answers together -- the travel
// path issues this AND joinPolicyFacts before it can decide, and a player who
// has just clicked a destination is watching.
//
// `originWaypointId` is supplied by the AUTHORITY from its own World object: it
// is the waypoint on the tile the player is standing on according to the tick
// loop's arithmetic, or null. It is never read off the frame. Passing null makes
// `standingOnActivatedWaypoint` false, which is why "on no waypoint" and "on an
// unlit one" reach mayJoin as the same fact.
//
// The destination row is returned whole because the caller needs its x/y for
// pendingArrivals -- landing the player on the destination TILE is the whole
// difference between this and a world-granularity teleport.
async function waypointTravelFacts(pool, characterId, originWaypointId, destinationWaypointId) {
  const r = await pool.query(
    `SELECT wp.id, wp.world_id, wp.x, wp.y, wp.name,
            EXISTS (SELECT 1 FROM character_waypoints cw
                     WHERE cw.character_id = $1 AND cw.waypoint_id = wp.id) AS destination_activated,
            EXISTS (SELECT 1 FROM character_waypoints co
                     WHERE co.character_id = $1 AND co.waypoint_id = $3::uuid) AS origin_activated
       FROM waypoints wp WHERE wp.id = $2::uuid`,
    [characterId, destinationWaypointId, originWaypointId],
  );
  // No destination row: the id is not a waypoint, or names one that was
  // de-authored between the popup rendering and the click. Both are refusals,
  // and the empty result also means the origin answer is unknown -- so it fails
  // closed rather than being carried over from a row that does not exist.
  if (r.rows.length === 0) {
    return { destination: null, standingOnActivatedWaypoint: false, destinationActivated: false };
  }
  const row = r.rows[0];
  return {
    destination: {
      id: row.id, worldId: row.world_id, x: Number(row.x), y: Number(row.y), name: row.name,
    },
    standingOnActivatedWaypoint: row.origin_activated === true,
    destinationActivated: row.destination_activated === true,
  };
}

module.exports = { mayJoin, joinPolicyFacts, waypointTravelFacts };
