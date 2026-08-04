// Every player-progression tunable, in one file.
//
// PROVISIONAL BY CONSTRUCTION. The design chose three XP sources -- kills,
// chests and dungeon clears -- and only kills exist in this slice. Tuning a
// curve against one third of its inputs guarantees retuning once B (chests)
// and C (dungeons) land, so these are first numbers, not balanced ones, and
// XP balance is explicitly out of scope for A2.
//
// The one property that is NOT provisional: every formula in playerStats.js
// is an identity at BASE_STAT. A fresh character must reproduce the game's
// pre-A2 numbers exactly -- 100 hp, 100 mana, 10 mana/s, x1.0 damage, x1.0
// cooldown, 0.5 sell fraction. Change a growth rate freely; never change a
// base such that a level-1 character's numbers move.

const BASE_STAT = 5;
const STAT_KEYS = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];
const MAX_LEVEL = 50;
const STAT_POINTS_PER_LEVEL = 3;

// CON -> max hp. Base matches PLAYER_MAX_HP (authority/world.js:17).
const HP_BASE = 100;
const HP_PER_CON = 10;

// INT -> max mana. Base matches PLAYER_MAX_MANA (authority/world.js:18).
const MANA_BASE = 100;
const MANA_PER_INT = 10;

// STR -> physical damage, INT -> every other element. The split is the
// weapon's existing `element` column; no new field.
const MELEE_PER_STR = 0.05;
const SPELL_PER_INT = 0.05;

// DEX -> attack speed, as a cooldown MULTIPLIER (lower is faster). The floor
// exists because the multiplier is 1/(1+k*n): without it a high enough DEX
// approaches a zero cooldown, i.e. an unbounded attack rate.
const HASTE_PER_DEX = 0.03;
const MIN_COOLDOWN_MULT = 0.4;

// WIS -> mana regen. Base matches PLAYER_MANA_REGEN (authority/world.js:19).
// Contrary to the design doc, mana regen ALREADY EXISTS -- WIS scales a live
// constant here, it does not introduce a new tick.
const MANA_REGEN_BASE = 10;
const MANA_REGEN_PER_WIS = 0.5;

// CHA -> merchant sell price. SELL_FRACTION_BASE matches merchantStock.js's
// existing SELL_FRACTION.
//
// SELL_FRACTION_MAX is a SAFETY bound, not a balance knob. The village base
// catalog sells items at `value` and buys them back at `value * fraction`.
// A fraction >= 1.0 makes buy-then-sell a money printer against an infinite,
// never-expiring catalog. Keep this strictly below 1.0 forever.
const PRICE_PER_CHA = 0.02;
const SELL_FRACTION_BASE = 0.5;
const SELL_FRACTION_MAX = 0.9;

// XP curve. xpToNext(level) = XP_BASE * level, so the cumulative floor is
// XP_BASE * (level-1) * level / 2: 0, 100, 300, 600, 1000, ...
const XP_BASE = 100;

// Kill XP scales with the creature's A1 level RELATIVE to the player's, so
// farming trivial creatures decays to literally zero (diff <= -5).
const XP_KILL_BASE = 10;
const XP_LEVEL_DIFF_SLOPE = 0.2;
const XP_LEVEL_DIFF_MAX = 2;

// Death costs a RANDOM slice of what the current level is worth -- between
// 0.5% and 10% of xpToNext(level), rolled fresh on every death. The base is
// the level's full cost, NOT the progress already made into it, so the sting
// of dying does not shrink just because a player died early in a level.
//
// The roll is uniform over [MIN, MAX]. The randomness is drawn by the caller
// and passed in, never called inside the formula -- see applyDeathPenalty.
//
// The never-de-level guarantee is unaffected: the loss is still clamped at
// xpFloor(level), so a player who has just levelled up loses nothing, and one
// who is 3% into a level loses at most that 3%.
const DEATH_PENALTY_MIN = 0.005;
const DEATH_PENALTY_MAX = 0.10;

// Respec cost in gold: RESPEC_BASE * level.
const RESPEC_BASE = 50;

module.exports = {
  BASE_STAT, STAT_KEYS, MAX_LEVEL, STAT_POINTS_PER_LEVEL,
  HP_BASE, HP_PER_CON, MANA_BASE, MANA_PER_INT,
  MELEE_PER_STR, SPELL_PER_INT, HASTE_PER_DEX, MIN_COOLDOWN_MULT,
  MANA_REGEN_BASE, MANA_REGEN_PER_WIS,
  PRICE_PER_CHA, SELL_FRACTION_BASE, SELL_FRACTION_MAX,
  XP_BASE, XP_KILL_BASE, XP_LEVEL_DIFF_SLOPE, XP_LEVEL_DIFF_MAX,
  DEATH_PENALTY_MIN, DEATH_PENALTY_MAX, RESPEC_BASE,
};
