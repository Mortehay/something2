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
// SOMET-311 measured this table's runtime price, one player parked in each
// world's densest radius-1 chunk neighbourhood (9 chunks = 9,216 tiles, the
// set the authority activates AND broadcasts) against the dev stack on
// 2026-08-16, 20-45s samples:
//
//   world (size, tier)                 rows   per-broadcast   bytes/frame  per-socket
//   Ashfields Reach (96, sparse)         28      28              5.3 KB     30 KiB/s
//   Ossuary Depths: Entry (128, normal) 102      60             11.5 KB     60 KiB/s
//   Crystal Foundry: Entry (192, horde) 907     194             36.2 KB    180 KiB/s
//   The Abyss: Hub (224, swarm)        2469     549-571        104-108 KB  510-528 KiB/s
//
// Creature frames go out every 4 ticks (5 Hz) at ~184 bytes/creature, so the
// per-socket cost is ~920 B/s PER CREATURE in the neighbourhood, and it is
// paid once per socket. The tick loop itself held 19.83-19.96 Hz against a
// nominal 20 Hz in every world, so this is a BANDWIDTH cost, not a tick-budget
// one: `swarm` is ~4.2 Mbit/s of JSON down one socket, ~97% of it outside the
// ~225 tiles the client can actually see. The lever for that is the broadcast
// AOI (broadcastCreatures' neighbourhood radius / the wire shape), not this
// table and not the size ramp -- see escalation.js's SIZE_STEPS comment.
const DENSITY_TIERS = {
  dead:   { perThousand: 0,  packCount: 0, packSizeMin: 0, packSizeMax: 0 },
  sparse: { perThousand: 3,  packCount: 0, packSizeMin: 0, packSizeMax: 0 },
  normal: { perThousand: 6,  packCount: 1, packSizeMin: 3, packSizeMax: 4 },
  dense:  { perThousand: 12, packCount: 2, packSizeMin: 4, packSizeMax: 6 },
  horde:  { perThousand: 24, packCount: 4, packSizeMin: 5, packSizeMax: 8 },
  swarm:  { perThousand: 48, packCount: 6, packSizeMin: 8, packSizeMax: 12 },
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
// Raised from 2000 to 4000 when the tier rates doubled (SOMET-302). The
// deepest world on the size ramp -- 224x224 at swarm -- resolves to 2408,
// so no world the game ships is near this; it still guards the case it was
// written for, resolveDensity('normal', 4096, 4096).
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
