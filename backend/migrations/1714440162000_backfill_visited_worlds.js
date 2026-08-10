exports.shorthands = undefined;

// Backfill character_visited_worlds from world_players (SOMET-263 follow-up).
//
// 1714440160000 created character_visited_worlds EMPTY, and visits are only
// recorded from that point forward -- on join and on transition. So every
// character that existed before SOMET-256 shows "You have not been anywhere
// yet" on the player World Map forever, even though world_players already
// records exactly which worlds it has stood in. When this was found, the admin
// account's character had 10 world_players rows and 0 visit rows.
//
// A world_players row IS evidence of a visit: only the authority's persist()
// writes that table, and only for a player actually in the world.
//
// first_seen_at is APPROXIMATE here, knowingly. world_players.updated_at is
// when the character was LAST there, not first -- but it is the only evidence
// that survived, nothing currently renders the timestamp, and a
// wrong-but-ordered value preserves the relative order of exploration, which
// now() would flatten to a single instant. Visits recorded from here on are
// exact. If a "first discovered" date is ever surfaced, backfilled rows will
// be wrong and this comment is the reason why.
exports.up = (pgm) => {
  pgm.sql(`INSERT INTO character_visited_worlds (character_id, world_id, first_seen_at)
           SELECT character_id, world_id, updated_at FROM world_players
           ON CONFLICT (character_id, world_id) DO NOTHING`);
};

// Deliberately empty, not unimplemented. A rollback cannot distinguish a row
// this migration created from one the character earned by playing afterwards,
// and deleting the latter would destroy real history. Re-running `up` is
// harmless (ON CONFLICT DO NOTHING), so there is nothing a `down` needs to
// undo to make the migration re-appliable.
exports.down = () => {};
