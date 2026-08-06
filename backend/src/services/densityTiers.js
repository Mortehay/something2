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
const DENSITY_TIERS = {
  dead:   { perThousand: 0,   packCount: 0, packSizeMin: 0, packSizeMax: 0 },
  sparse: { perThousand: 1.5, packCount: 0, packSizeMin: 0, packSizeMax: 0 },
  normal: { perThousand: 3,   packCount: 1, packSizeMin: 3, packSizeMax: 4 },
  dense:  { perThousand: 6,   packCount: 2, packSizeMin: 4, packSizeMax: 6 },
  horde:  { perThousand: 12,  packCount: 4, packSizeMin: 5, packSizeMax: 8 },
  swarm:  { perThousand: 24,  packCount: 6, packSizeMin: 8, packSizeMax: 12 },
};

const DENSITY_NAMES = Object.keys(DENSITY_TIERS);
const DEFAULT_DENSITY = 'normal';

// Pure. Never reads a database -- populateWorld does the writing, including
// persisting scatterCount back to worlds.creature_count.
function resolveDensity(tier, width, height) {
  const key = tier ?? DEFAULT_DENSITY;
  const t = DENSITY_TIERS[key];
  if (!t) throw new Error(`unknown density tier "${tier}"`);
  const area = (Number(width) || 0) * (Number(height) || 0);
  return {
    scatterCount: Math.round((t.perThousand * area) / 1000),
    packCount: t.packCount,
    packSizeMin: t.packSizeMin,
    packSizeMax: t.packSizeMax,
  };
}

module.exports = { DENSITY_TIERS, DENSITY_NAMES, DEFAULT_DENSITY, resolveDensity };
