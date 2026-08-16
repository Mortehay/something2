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
//
// RUNTIME PRICE -- and a warning about the table below (SOMET-311, re-scaled
// by SOMET-350). SOMET-311 measured this table's cost with one player parked
// in each world's densest radius-1 chunk neighbourhood (9 chunks = 9,216
// tiles, the set the authority activates AND broadcasts) against the dev stack
// on 2026-08-16, 20-45s samples:
//
//   world (size, tier)                 rows   per-broadcast   bytes/frame  per-socket
//   Ashfields Reach (96, sparse)         28      28              5.3 KB     30 KiB/s
//   Ossuary Depths: Entry (128, normal) 102      60             11.5 KB     60 KiB/s
//   Crystal Foundry: Entry (192, horde) 907     194             36.2 KB    180 KiB/s
//   The Abyss: Hub (224, swarm)        2469     549-571        104-108 KB  510-528 KiB/s
//
// THOSE ROWS WERE MEASURED AT THE OLD RATES (3/6/12/24/48), one merge before
// this comment existed. They are kept for the SHAPE of the cost, not its
// current magnitude. The re-scale above multiplies population by 3x at
// sparse/normal/dense and 1.85x at swarm while the per-creature wire cost is
// unchanged, so every per-socket figure moves with it. The Abyss: Hub now
// resolves to ~4466 creatures (89 * 50176 / 1000) rather than 2469, which
// projects to roughly 1000 per broadcast and ~940 KiB/s -- about 7.5 Mbit/s of
// JSON down a single socket. PROJECTED, NOT RE-MEASURED: re-running SOMET-311's
// method after this merge is the honest next step.
//
// What survives the re-scale is the invariant, because it is per-creature:
// creature frames go out every 4 ticks (5 Hz) at ~184 bytes/creature, so the
// per-socket cost is ~920 B/s PER CREATURE in the neighbourhood, paid once per
// socket. The tick loop held 19.83-19.96 Hz against a nominal 20 Hz in every
// world measured, so this is a BANDWIDTH cost, not a tick-budget one, and ~97%
// of it is outside the ~225 tiles the client can actually see. The lever is the
// broadcast AOI (broadcastCreatures' neighbourhood radius / the wire shape),
// not this table and not the size ramp -- see escalation.js's SIZE_STEPS
// comment, and SOMET-354.
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
// This is the same number PUT /api/worlds/:id caps creature_count at (the cap
// SOMET-188 / F-008 introduced at 2000), moved to where it still bites. That cap explained
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
//
// SOMET-350 Task 5: raised 4000 -> 5000 on a measurement, not a guess.
// CreatureSim.tick (authority/creatures.js) has a cheap, chunk-scoped
// behaviour loop and an EXPENSIVE unscoped pass -- computeAuras, O(leaders x
// all), running over the whole population every tick regardless of the
// active chunk set. Leader count, not headcount, is what bends the curve, so
// the population/leader sweep below deliberately varies leaders, using the
// Champion behaviour (aura_radius 260, the only aura-carrying entry in the
// catalog and what a later slice promotes pack masters into).
//
// Measured 2026-08-16 on an AMD Ryzen 5 7530U (12 logical cores), backend/tests/
// creature_tick_cost.test.js, CreatureSim.tick with a 3x3 active chunk block:
//   2400 creatures /   6 leaders: 1.010 ms/tick
//   4500 creatures /   6 leaders: 1.897 ms/tick
//   4500 creatures /  50 leaders: 6.839 ms/tick
//   4500 creatures / 200 leaders: 25.787 ms/tick
// computeAuras is O(leaders x all) and runs over the WHOLE population every
// tick, outside the chunk gate -- so the leader count, not the headcount, is
// what bends this curve. Slice B (pack masters use the Champion behaviour,
// the only one with aura_radius > 0) must budget against the last two rows:
// a single active area with 50 leaders already spends most of the 8ms
// half-budget, and 200 leaders blows well past the whole 16ms frame budget.
// The 5000-creature/6-leader decision row itself has headroom to spare.
const MAX_WORLD_CREATURES = 5000;

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
