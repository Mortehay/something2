exports.shorthands = undefined;

// Whether a world is a legal destination for map-based fast travel (Plan B
// slice 1, docs/superpowers/plans/2026-08-10-map-fast-travel.md).
//
// DEFAULT FALSE IS THE SAFETY PROPERTY, not a convenience. 7 creatures carry
// blocks_portal_id specifically to gate dungeon entrances, and level bands run
// 1-1 to 47-50 across 86 worlds. If travel were allowed to anywhere a character
// has ever been, both mechanics become skippable. Opting in per world means a
// dungeon interior is never a target unless somebody deliberately made it one,
// so gating survives BY CONSTRUCTION rather than by a rule someone has to
// remember to apply.
//
// Deliberately NOT backfilled: no world becomes a travel target as a side
// effect of this migration. Classification is authored in the map specs
// (slice 2) so it is reviewable in a diff and survives a re-seed -- unlike
// is_entry, which was set on live rows and has since gone missing (SOMET-265).
exports.up = (pgm) => {
  pgm.addColumns('worlds', {
    allows_fast_travel: { type: 'boolean', notNull: true, default: false },
  });
};

exports.down = (pgm) => pgm.dropColumns('worlds', ['allows_fast_travel']);
