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
  // A negative radius is meaningless. The upper bound is a BACKSTOP against an
  // absurd value, not authoring guidance -- Chebyshev dilation saturates fast
  // against the real generator (default pathCell 24, pathJitter 6). Measured
  // fraction of tiles the road leg alone marks safe, by map size and radius:
  //
  //   map     | road cells | r=1 | r=2 | r=3 | r=4 | r=6 | r=8
  //   48x48   |    8.4%    | 24% | 38% | 49% | 58% | 74% | 87%
  //   64x64   |    9.1%    | 26% | 40% | 52% | 63% | 80% | 92%
  //   96x96   |    9.6%    | 26% | 41% | 53% | 63% | 81% | 92%
  //
  // At radius 8 a 64-tile world is 92% safe, not "mostly wild" -- radius 3
  // already crosses half the map. The RECOMMENDED AUTHORING RANGE is 1-3; a
  // 96x96 `swarm` world measured at r=8 delivered only 212 of 221 requested
  // scatter and 24 of 32 pack members, silently. 8 stays the CHECK ceiling
  // because it is already applied to the live database and is a sanity
  // backstop, not a target -- the map spec validator rejects the same range
  // with a readable message for anything that writes the column directly.
  pgm.addConstraint('worlds', 'worlds_safe_road_radius_check',
    'CHECK (safe_road_radius >= 0 AND safe_road_radius <= 8)');
};

exports.down = (pgm) => {
  pgm.dropConstraint('worlds', 'worlds_safe_road_radius_check');
  pgm.dropColumns('worlds', ['safe_road_radius', 'safe_rects']);
};
