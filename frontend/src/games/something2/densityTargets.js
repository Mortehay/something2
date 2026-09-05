// What a "creatures per screen" number can ACTUALLY be.
//
// `target_per_screen` reads like a continuous dial and is not one. The remote
// generator picks one of a fixed set of density tiers, and the resulting
// population is `perThousand * area / 1000` -- so the achievable per-screen
// values are a five-position switch, not a range. Asking for 6.0 produces 4.1,
// a 32% shortfall, and nothing in the number itself says so.
//
// This module exists so the form can show what will be produced beside what was
// asked, rather than offering a control that quietly rounds.
//
// DUPLICATED FROM backend/src/services/densityTiers.js, deliberately and with
// the same standing as the STEP table in mapGraphLayout.js: the frontend cannot
// import from backend/, so the choice is a copy with a named drift target or a
// magic number with none. densityTargets.test.js asserts these stay in step with
// the backend file by reading its source text, so a tier re-scale there fails
// here rather than silently making this advice wrong.
//
// ONE SCREEN IS ~225 TILES: the canvas is a fixed 1280x720 with no zoom and a
// tile projects to a 128x64 iso diamond, so perThousand * 0.225 is creatures
// per screen. That constant is the other half of what must not drift.
export const TILES_PER_SCREEN = 225;

// `dead` (perThousand 0) is deliberately absent. It is a real tier in the
// backend table, but offering "a world with no creatures in it" as a suggestion
// in a generation form is not a density choice -- it is a different request,
// and one nobody makes by nudging a number.
export const DENSITY_TIERS = [
  { tier: 'sparse', perThousand: 9 },
  { tier: 'normal', perThousand: 18 },
  { tier: 'dense', perThousand: 36 },
  { tier: 'horde', perThousand: 62 },
  { tier: 'swarm', perThousand: 89 },
];

export const ACHIEVABLE = DENSITY_TIERS.map(t => ({
  ...t,
  perScreen: Math.round((t.perThousand * TILES_PER_SCREEN) / 1000 * 10) / 10,
}));

// The tier a requested per-screen number will actually land on, and by how much
// it misses. Nearest by absolute distance; ties go to the LOWER tier, because
// over-populating a world costs bandwidth and under-populating it does not.
export function nearestAchievable(requested) {
  // An EMPTY field is not a request for zero, and Number('') is 0 -- so the
  // blank/whitespace case is rejected before the numeric one. Without this an
  // untouched form would confidently advise "sparse", which is a recommendation
  // nobody asked for.
  if (requested === null || requested === undefined) return null;
  if (typeof requested === 'string' && requested.trim() === '') return null;
  const want = Number(requested);
  if (!Number.isFinite(want)) return null;
  let best = ACHIEVABLE[0];
  for (const t of ACHIEVABLE) {
    if (Math.abs(t.perScreen - want) < Math.abs(best.perScreen - want)) best = t;
  }
  const shortfall = want === 0 ? 0 : (best.perScreen - want) / want;
  return { ...best, requested: want, shortfall, missesBy: Math.abs(shortfall) };
}

// Whether the gap is worth putting in front of a person. 15% matches the
// threshold the generator itself warns at, so the two surfaces do not disagree
// about when a target is being quietly ignored.
export const MISS_THRESHOLD = 0.15;
export function isMisleading(requested) {
  const hit = nearestAchievable(requested);
  return Boolean(hit && hit.missesBy > MISS_THRESHOLD);
}
