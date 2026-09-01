/* eslint-disable camelcase */

// SOMET-524. A free full respec, ahead of the passive tree v2 reseed.
//
// WHY THIS IS NECESSARY. seed-passive-tree.js only writes `grants` under
// --force (the upsert's `CASE WHEN $10 OR EXCLUDED.kind = 'start'`), so the v2
// retune reaches a live database only via `make seed-passive-tree FORCE=1`.
// That rewrites labels, kinds and grants UNDER nodes players have already
// allocated: a node someone bought for +2 STR may now grant +2 INT, and a
// keystone they crossed the map for may have been replaced outright
// (ks_wis_clarity and ks_cha_beast_bond both became cluster hubs). Leaving
// their allocations in place would silently hand them a different build than
// the one they chose.
//
// So every point goes back and every player re-spends it.
//
// COUNTED, NEVER DERIVED. The refund is the number of character_passives rows
// that character actually holds. Deriving it from level would be a second
// source of truth for the wallet -- exactly the drift passiveRules.js refuses
// ("there is deliberately no passivePointsFor() here") -- and it would be
// WRONG here regardless: T2 already refunded pre-epic stat points into this
// same column, so level and allocation count legitimately disagree.
//
// ORDER MATTERS AND IT IS NOT ENFORCEABLE FROM HERE. This migration must run
// BEFORE the forced reseed. The reseed prunes nodes the generator no longer
// produces and DELETEs their character_passives rows on the way; if it ran
// first, those points would be gone and this could not count them. Migrations
// run before seeds in every deploy path this repo has, which is what makes the
// ordering hold -- see the Makefile's `migrate-up` / `seed-passive-tree`.
//
// IDEMPOTENT. A second run finds no rows, refunds 0, and deletes nothing.

exports.up = async (pgm) => {
  // One statement, so the count and the delete cannot disagree: the CTE reads
  // the rows, the UPDATE credits from that same read, and the DELETE removes
  // exactly what was counted. Doing this as three statements would leave a
  // window where a concurrent allocation is credited but not removed.
  await pgm.db.query(`
    WITH counted AS (
      SELECT character_id, count(*)::int AS n
        FROM character_passives
       GROUP BY character_id
    ), refunded AS (
      UPDATE player_progression p
         SET passive_points = p.passive_points + c.n,
             updated_at = now()
        FROM counted c
       WHERE p.character_id = c.character_id
      RETURNING p.character_id
    )
    DELETE FROM character_passives
     WHERE character_id IN (SELECT character_id FROM refunded)
  `);

  // A character can hold allocations while having NO player_progression row.
  // This is not hypothetical -- 3 of 26 characters on the dev database are in
  // that state -- because progressionStore.loadProgression CREATES the row
  // lazily on first read rather than at character creation:
  //
  //   INSERT INTO player_progression (character_id) ... ON CONFLICT DO NOTHING
  //
  // so a character that has never been loaded since that code landed has none.
  // The UPDATE above joins player_progression and therefore skips them
  // entirely, and an earlier draft of this migration simply DELETEd their
  // rows -- destroying points nobody was ever credited for.
  //
  // Instead, create the row the way loadProgression would and put the refund
  // straight into it. Then the delete below covers everyone.
  await pgm.db.query(`
    INSERT INTO player_progression (character_id, passive_points)
    SELECT cp.character_id, count(*)::int
      FROM character_passives cp
     WHERE NOT EXISTS (
       SELECT 1 FROM player_progression p WHERE p.character_id = cp.character_id)
     GROUP BY cp.character_id
    ON CONFLICT (character_id) DO NOTHING
  `);
  await pgm.db.query('DELETE FROM character_passives');
};

// NOT REVERSIBLE, deliberately. The allocations are gone and which nodes they
// pointed at was not recorded -- recording it would mean keeping a shadow copy
// of a table we just deleted, to restore a build against tree data that no
// longer exists. Rolling back leaves players holding the refunded points,
// which is the safe direction: they can re-spend them.
exports.down = () => {};
