// backend/scripts/dungeon/escalation.js
//
// Pure hop-distance -> level_band/density derivation for P5 (SOMET-251).
// hopFraction is hopDistance / maxHopDistance across the WHOLE assembled
// graph (computed by the generator's BFS from the single entry, Task 4),
// clamped to [0,1]. Mirrors map_spec_fixtures.test.js's own escalation
// check -- floor and ceiling both non-decreasing by hop, deepest ceiling
// >= 2x the entry's -- so a spec built from this module passes that check
// by construction rather than by luck.
//
// A branch/spur room (Task 3's skeletons mark these) must use its
// ATTACHMENT point's hopFraction, not its own slightly-larger one -- the
// generator is responsible for that substitution before calling this
// function; this module only implements the curve.
function deriveLevelBand(hopFraction, tierClamp) {
  const [floor, ceiling] = tierClamp;
  const span = ceiling - floor;
  const width = Math.max(2, Math.round(span * 0.35));
  const center = floor + hopFraction * span;
  const min = Math.max(floor, Math.round(center - width / 2));
  const max = Math.min(ceiling, Math.max(min + 1, Math.round(center + width / 2)));
  return [min, max];
}

// 'dead' is deliberately excluded -- this is real content, not an empty
// room. 5 usable tiers stepped evenly across the full hop range.
const DENSITY_ORDER = ['sparse', 'normal', 'dense', 'horde', 'swarm'];
function deriveDensity(hopFraction) {
  const idx = Math.min(DENSITY_ORDER.length - 1, Math.floor(hopFraction * DENSITY_ORDER.length));
  return DENSITY_ORDER[idx];
}

module.exports = { deriveLevelBand, deriveDensity, DENSITY_ORDER };
