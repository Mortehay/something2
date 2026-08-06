// Creature level: the roll, and what a level does to a creature's stats.
//
// This module is PURE and takes a plain number in [0,1) rather than an RNG,
// so its two callers can each supply their own deterministic source without
// this module caring what it is:
//   - placeMapCreatures  (mapService.js:540) draws from makeRng(rngSeed)
//   - placeCreaturePacks (mapService.js:609) draws from its own makeRng
//     stream, salted (PACK_SALT) so it never reuses placeMapCreatures' draws
// Handing this module the draw instead of the generator keeps both callers
// deterministic on their own terms and keeps this file trivially testable.
//
// Server-side only. The repo already carries a two-copy resolveMove between
// frontend movement.js and backend authority/collision.js and must not grow a
// second such pair -- the client is told a creature's already-scaled hp and
// level, and never recomputes either.

// Growth per level beyond 1. Provisional: these are the first numbers, not
// tuned ones, and the A2 XP curve will want them revisited once player
// progression exists to measure them against.
const LEVEL_HP_GROWTH = 0.15;          // +15% of base hp per level
const LEVEL_DAMAGE_GROWTH = 0.10;      // +10% of base damage per level
const LEVEL_DEFENSE_PER_LEVEL = 0.5;   // flat, because defense is subtractive

// Map a [0,1) draw onto [levelMin, levelMax] inclusive.
//
// Returns 1 for a missing or inverted band rather than throwing: spawning runs
// inside the transaction that also writes the world_chunks once-only flag
// (server.js:341-348), so a throw would roll that flag back and the chunk
// would retry spawning forever.
function rollCreatureLevel(unit, levelMin, levelMax) {
  const lo = Number.isInteger(levelMin) ? levelMin : null;
  const hi = Number.isInteger(levelMax) ? levelMax : null;
  if (lo === null || hi === null || lo < 1 || hi < lo) return 1;
  const u = Number.isFinite(unit) ? Math.min(0.999999999, Math.max(0, unit)) : 0;
  return lo + Math.floor(u * (hi - lo + 1));
}

// Round to 2dp without floating-point noise (5 * 1.9 is 9.500000000000002).
function round2(n) { return Math.round(n * 100) / 100; }

// Scale the three stats a level affects. Returns ONLY those three -- callers
// carry `resistances` through untouched by design.
function scaleCreature(base, level) {
  const lv = Number.isInteger(level) && level >= 1 ? level : 1;
  const steps = lv - 1;
  const baseHp = Number(base.hp) || 0;
  const baseDamage = Number(base.damage) || 0;
  const baseDefense = Number(base.defense) || 0;
  return {
    // Math.max(1, ...) so a creature type mis-authored with hp 0 still spawns
    // killable rather than dead-on-arrival.
    hp: Math.max(1, Math.round(baseHp * (1 + LEVEL_HP_GROWTH * steps))),
    damage: round2(baseDamage * (1 + LEVEL_DAMAGE_GROWTH * steps)),
    defense: round2(baseDefense + LEVEL_DEFENSE_PER_LEVEL * steps),
  };
}

module.exports = {
  rollCreatureLevel, scaleCreature,
  LEVEL_HP_GROWTH, LEVEL_DAMAGE_GROWTH, LEVEL_DEFENSE_PER_LEVEL,
};
