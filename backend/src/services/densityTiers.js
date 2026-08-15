// The ONE table that turns an authored density keyword into placement numbers.
//
// Scaled per 1000 tiles rather than as an absolute count. An absolute count
// makes a 96x96 world (9216 tiles) meaningfully sparser than a 64x64 one
// (4096) at the same setting -- the trap `worlds.creature_count` walks into
// today, where hand-authored counts of 2-9 read very differently depending on
// the map they sit on.
//
// Keep the key set in sync with worlds_density_check (migration
// 1714440070000). The duplication is deliberate and documented there.
//
// Rates are per 1000 tiles, and they are the world's MEAN -- creatureDensityField
// redistributes around them, so a `normal` world holds quiet stretches and thick
// pockets while averaging this number.
//
// The per-screen column is what these were tuned against. The canvas is a fixed
// 1280x720 with no zoom and a tile projects to a 128x64 iso diamond (4096 px^2),
// so ONE SCREEN IS ~225 TILES and perThousand * 0.225 is creatures per screen.
// Before this table was re-scaled the game shipped 0.7-2.7 per screen -- and
// since every checked-in map spec uses only sparse/normal/dense, the top two
// tiers were theoretical.
//
//   tier     per1000   quiet(x0.15)   mean/screen   peak(x1.5)
//   sparse         9            0.3             2            3
//   normal        18            0.6             4            6
//   dense         36            1.2             8           12
//   horde         62            2.1            14           21
//   swarm         89            3.0            20           30
//
// packCount/packSize are untouched here; Slice B scales them by area.
const DENSITY_TIERS = {
  dead:   { perThousand: 0,  packCount: 0, packSizeMin: 0, packSizeMax: 0 },
  sparse: { perThousand: 9,  packCount: 0, packSizeMin: 0, packSizeMax: 0 },
  normal: { perThousand: 18, packCount: 1, packSizeMin: 3, packSizeMax: 4 },
  dense:  { perThousand: 36, packCount: 2, packSizeMin: 4, packSizeMax: 6 },
  horde:  { perThousand: 62, packCount: 4, packSizeMin: 5, packSizeMax: 8 },
  swarm:  { perThousand: 89, packCount: 6, packSizeMin: 8, packSizeMax: 12 },
};

const DENSITY_NAMES = Object.keys(DENSITY_TIERS);
const DEFAULT_DENSITY = 'normal';

// Hard ceiling on how many creatures ONE population pass may place.
//
// This is the same 2000 that PUT /api/worlds/:id has capped creature_count at
// since SOMET-188 / F-008, moved to where it still bites. That cap explained
// itself as bounding what the re-roll route places -- but since SOMET-246 the
// route resolves its count from `density` and never reads creature_count, so
// the number it guarded had stopped being an input. Area scaling then made the
// bound matter more, not less: POST/PUT /api/worlds accept width and height up
// to 4096, and resolveDensity('normal', 4096, 4096) is 50,332 scattered
// creatures -- about 6 seconds of synchronous, event-loop-blocking rejection
// sampling followed by 50k INSERTs inside one open write transaction. The
// authority shares this process, so that stalls the live game for every
// connected player.
//
// Clamped HERE rather than in populateWorld so both callers -- applyMapSpec
// and POST /api/worlds/:id/creatures -- are bounded by construction: neither
// can place more than this without first resolving a density, and there is
// exactly one resolver.
// Raised from 2000 to 4000 when the tier rates doubled (SOMET-302). After
// the density tier re-scale (SOMET-350), the deepest world on the size ramp
// -- 224x224 at swarm -- resolves to ~4466 (89 * 50176 / 1000) and IS now
// clamped. The cap still guards against larger maps and resolveDensity('normal', 4096, 4096).
const MAX_WORLD_CREATURES = 4000;

// Pure. Never reads a database -- populateWorld does the writing, including
// persisting scatterCount back to worlds.creature_count.
function resolveDensity(tier, width, height) {
  const key = tier ?? DEFAULT_DENSITY;
  const t = DENSITY_TIERS[key];
  if (!t) throw new Error(`unknown density tier "${tier}"`);
  const area = (Number(width) || 0) * (Number(height) || 0);
  // Packs are absorbed into the ceiling rather than clamped themselves: the
  // largest tier asks for 6 packs of at most 12, so the pack budget is 72 in
  // the worst case and a tier's pack shape is worth preserving intact. The
  // scatter takes whatever is left, so scatter + packs never exceeds the cap
  // no matter how large the map is.
  const packBudget = t.packCount * t.packSizeMax;
  const ceiling = MAX_WORLD_CREATURES - packBudget;
  const target = Math.round((t.perThousand * area) / 1000);
  // `clamped` exists because truncation used to be invisible: a caller could
  // not tell "this world was authored thin" from "this world was cut to fit".
  // Math.max(0, ...) is defensive only -- MAX_WORLD_CREATURES is far above
  // any tier's pack budget.
  const scatterCount = Math.max(0, Math.min(target, ceiling));
  return {
    scatterCount,
    packCount: t.packCount,
    packSizeMin: t.packSizeMin,
    packSizeMax: t.packSizeMax,
    clamped: target > ceiling,
  };
}

module.exports = {
  DENSITY_TIERS, DENSITY_NAMES, DEFAULT_DENSITY, MAX_WORLD_CREATURES, resolveDensity,
};
