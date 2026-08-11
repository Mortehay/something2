exports.shorthands = undefined;

// The five hub-vale worlds that slice 2 classified as fast-travel targets, but
// which the seeder cannot deliver (SOMET-273).
//
// WHY A MIGRATION AND NOT A SEED. Every other world's allows_fast_travel comes
// from its map spec, which is the right place for it. hub-vale.map.json cannot
// be applied:
//
//   * Its topology is stale. It declares an isolated 5-world hub-and-spoke
//     (hub S -> mire), but live these worlds are wired into the 86-world map:
//     Vale Crossing S -> Sealed Mausoleum, Blackfen Sinks N -> Sunscar Flats
//     and E -> Rimehollow. seed-map.js never deletes a link a spec has dropped
//     and setLink is ON CONFLICT DO UPDATE, so applying it would repoint edges
//     and leave two mirrors orphaned one-way.
//
//   * It cannot be CORRECTED either. validateMapSpec enforces that a link's
//     edge agrees with the worlds' grid cells, and the live shape is not
//     grid-representable: dunes S -> mire needs mire at [-1,1] while frozen
//     W -> mire needs it at [-1,-1]. A link-less spec fails validation too --
//     "exactly one is_entry" plus "unreachable from the entry" for the rest.
//
// So the spec is not the source of truth for these five and cannot become one
// without reworking the spec format. This migration carries the classification
// instead, and says so out loud rather than leaving 5 of 30 travel targets
// quietly missing.
//
// The names are HARDCODED, deliberately. Reading hub-vale.map.json at run time
// would be one source of truth, but it would also mean a later edit to that
// file silently changes what an already-applied migration did -- migrations
// have to be frozen. They match the `allows_fast_travel: true` entries in
// backend/seeds/maps/hub-vale.map.json as of 2026-08-11.
//
// None of the five is a dungeon room, so this cannot open a portal-guard
// bypass; world_fast_travel_db.test.js asserts that against the live rows.
const WORLDS = [
  'Vale Crossing',
  'Thornbriar Reach',
  'Sunscar Flats',
  'Rimehollow',
  'Blackfen Sinks',
];

// Matched BY NAME, which is the same key seed-map.js upserts on, and scoped to
// worlds that are not already flagged so a re-run is a no-op. A name that does
// not exist (a fresh database seeded only from the other three specs) simply
// updates nothing rather than failing.
exports.up = (pgm) => {
  pgm.sql(`UPDATE worlds SET allows_fast_travel = true
            WHERE name IN (${WORLDS.map((n) => `'${n}'`).join(', ')})
              AND allows_fast_travel = false`);
};

// Reverses exactly what `up` sets. Unlike the visited-worlds backfill, this one
// CAN be undone honestly: the flag is authored data, not earned history, and
// these five names are the complete set this migration touched.
exports.down = (pgm) => {
  pgm.sql(`UPDATE worlds SET allows_fast_travel = false
            WHERE name IN (${WORLDS.map((n) => `'${n}'`).join(', ')})`);
};
