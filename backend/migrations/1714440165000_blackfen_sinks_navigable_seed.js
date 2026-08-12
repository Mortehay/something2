exports.shorthands = undefined;

// SOMET-273: Blackfen Sinks (hub-vale's "mire" world) ships sealed. Its LIVE
// doorways are N (-> Sunscar Flats) and E (-> Rimehollow) -- wired into the
// 86-world map, not the single stale S doorway hub-vale.map.json declares
// (see the migration this one follows, 1714440164000, and its commit
// message for the full topology-drift story). At its current seed, 2005,
// the terrain generated for those two live doorways forms a sealed pocket:
// a player crossing west from Rimehollow arrives somewhere with no path back
// out. Confirmed with the exact offline check p5_navigability.test.js runs
// (buildWorldGenConfig + assertNavigable + requiredTilesFor), fed the real
// doorways instead of the spec's: seed 2005 fails with
//   "doorway E at (32,63) is unreachable"
//   "arrival via doorway E at (32,62) is unreachable"
//
// hub-vale.map.json cannot be re-applied to fix this the normal way (spec's
// topology no longer matches live -- see 1714440164000's header), so the
// fix is a seed swap carried by a migration, same as that one.
//
// WHY 2011. The prior investigation (SOMET-273) hand-checked six candidate
// seeds against Blackfen Sinks' declared spec doorways: 2011, 2012, 2015,
// 2018, 2019, 2021. Re-run against the REAL live doorways (N, E) with the
// same harness, all six pass; 2011 is picked as the lowest / first of the
// six -- nothing else distinguishes it, and it collides with no other
// world's seed live. Do NOT reuse this reasoning for "mire" itself: SOMET-273
// left mire's seed untouched on purpose (nudging it would corrupt an
// unrelated pair of links -- see 1714440164000).
const OLD_SEED = 2005;
const NEW_SEED = 2011;

// world_chunks is the only PERSISTED terrain cache (GET /api/worlds/:id/chunk
// falls back to on-the-fly generation from worlds.seed on a miss -- see
// index.js); a stale row for the old seed would keep serving the sealed
// layout after this migration changes worlds.seed. Scoped by joining back to
// worlds.name so this can never touch another world's chunks, same shape as
// 1714440043000_biomes.js's down(). At the time of writing this world has 0
// persisted chunks (never finished generating, per the sealed-pocket defect
// this migration fixes), so the DELETE is a no-op safety net, not a repair
// for existing bad data.
exports.up = (pgm) => {
  pgm.sql(`UPDATE worlds SET seed = ${NEW_SEED} WHERE name = 'Blackfen Sinks' AND seed != ${NEW_SEED}`);
  pgm.sql(`DELETE FROM world_chunks USING worlds WHERE world_chunks.world_id = worlds.id AND worlds.name = 'Blackfen Sinks'`);
};

exports.down = (pgm) => {
  pgm.sql(`UPDATE worlds SET seed = ${OLD_SEED} WHERE name = 'Blackfen Sinks' AND seed != ${OLD_SEED}`);
  pgm.sql(`DELETE FROM world_chunks USING worlds WHERE world_chunks.world_id = worlds.id AND worlds.name = 'Blackfen Sinks'`);
};
