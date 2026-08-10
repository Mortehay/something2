// Which worlds a character has entered (SOMET-263), for the player's
// fog-of-war World Map.
//
// ONE helper, called from BOTH places a character can enter a world: the join
// handler and the transition handler. Two copies of this INSERT is how a
// feature ends up wired into one path and dead in the other -- the exact shape
// that shipped an inert creature-behaviour loader in P2a. A visit recorded on
// join but not on transition passes every test written against join and is
// dead the moment a player walks through a portal.
// visited_worlds_db.test.js asserts both call sites exist.

// DO NOTHING, not DO UPDATE: first_seen_at means first, and a re-visit must not
// move it.
async function recordVisit(pool, characterId, worldId) {
  await pool.query(
    `INSERT INTO character_visited_worlds (character_id, world_id)
     VALUES ($1, $2) ON CONFLICT (character_id, world_id) DO NOTHING`,
    [characterId, worldId],
  );
}

async function listVisited(pool, characterId) {
  const r = await pool.query(
    'SELECT world_id FROM character_visited_worlds WHERE character_id = $1',
    [characterId],
  );
  return r.rows.map((x) => ({ worldId: x.world_id }));
}

module.exports = { recordVisit, listVisited };
