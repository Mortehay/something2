// backend/scripts/dungeon/escalation.js
//
// Pure hop-distance -> level_band/density derivation for P5 (SOMET-251).
// hopFraction is hopDistance / maxHopDistance across the WHOLE assembled
// graph (computed by the generator's BFS from the single entry, Task 4),
// clamped to [0,1]. This module guarantees, for any single tierClamp:
// floor and ceiling are both non-decreasing as hopFraction rises, and
// neither ever exceeds the given tierClamp. It does NOT by itself
// guarantee the deepest ceiling is >= 2x the entry's -- that emerges from
// how Task 4's generator shares one hopFraction range across the whole
// 8-dungeon chain (each dungeon only ever sees the narrow slice of [0,1]
// it actually occupies), not from this curve evaluated at f=0/f=1 for an
// arbitrary tierClamp in isolation.
//
// A branch/spur room (Task 3's skeletons mark these) must use its
// ATTACHMENT point's hopFraction, not its own slightly-larger one -- the
// generator is responsible for that substitution before calling this
// function; this module only implements the curve.
//
// Precondition: tierClamp must have span (ceiling - floor) >= ~2 for the
// positive-band-width guarantee to hold; a zero-span clamp degenerates to
// [floor, floor] for every hopFraction. No current tierClamp in content.js
// has zero span (narrowest is 16), so this isn't defended against below.
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

// Progression-scaled world size in tiles (worlds are square). Same input and
// same bucket shape as deriveDensity, so all three progression properties --
// level band, density, size -- come from one hopFraction in one module.
//
// Every step is a multiple of the 32-tile chunk size, so a world always
// divides into whole chunks. The steps are chosen against a viewport that
// shows ~225 tiles at once (1280x720 with a translate-only camera and an
// isometric area scale of K^2 = 0.4096): 96x96 is ~41 screens and 224x224 is
// ~223. The old uniform 64x64 was ~18. See the design doc for the derivation.
const SIZE_STEPS = [96, 128, 160, 192, 224];
function deriveSize(hopFraction) {
  const idx = Math.min(SIZE_STEPS.length - 1, Math.floor(hopFraction * SIZE_STEPS.length));
  return SIZE_STEPS[idx];
}

module.exports = {
  deriveLevelBand, deriveDensity, deriveSize, DENSITY_ORDER, SIZE_STEPS,
};
