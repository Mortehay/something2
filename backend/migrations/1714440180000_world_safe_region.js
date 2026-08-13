exports.shorthands = undefined;

// Safe territory, authored per world (SOMET-288).
//
// A hostile is never GENERATED inside a village, within safe_road_radius tiles
// of a carved road, or inside one of safe_rects. Consumed by
// services/safeRegion.js through creatureTileCandidates; nothing on the
// movement path reads either column.
//
// DEFAULT 0 / '[]' IS THE COMPATIBILITY PROPERTY, not a convenience, and
// deliberately NOT backfilled -- exactly the posture allows_fast_travel took in
// 1714440163000. 86 worlds exist; with radius 0 the road leg of the predicate
// is dead and every one of them places byte-for-byte the creatures it placed
// before this migration. A world becomes safe only when a map spec says so, in
// a diff somebody reviewed.
exports.up = (pgm) => {
  pgm.addColumns('worlds', {
    safe_road_radius: { type: 'integer', notNull: true, default: 0 },
    safe_rects: { type: 'jsonb', notNull: true, default: '[]' },
  });
  // A negative radius is meaningless and a huge one swallows the map; 8 is
  // wider than any village and still leaves a 64-tile world mostly wild. The
  // map spec validator rejects the same range with a readable message -- this
  // is the backstop for anything that writes the column directly.
  pgm.addConstraint('worlds', 'worlds_safe_road_radius_check',
    'CHECK (safe_road_radius >= 0 AND safe_road_radius <= 8)');
};

exports.down = (pgm) => {
  pgm.dropConstraint('worlds', 'worlds_safe_road_radius_check');
  pgm.dropColumns('worlds', ['safe_road_radius', 'safe_rects']);
};
