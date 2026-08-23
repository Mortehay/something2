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
// pre-A2 numbers exactly -- 10 mana/s, x1.0 damage, x1.0 cooldown, 0.5 sell
// fraction, and for a WARRIOR 100 hp / 100 mana. Change a growth rate freely;
// never change a base such that a level-1 character's numbers move.
//
// SOMET-486 narrowed the pool half of that identity from "every class" to
// "Warrior": at BASE_STAT a character's pools are exactly its class's base
// pools, and Ranger/Mage are deliberately not 100/100. Every live character
// predating 486 is a Warrior, so nothing moved.

const BASE_STAT = 5;
const STAT_KEYS = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];
const MAX_LEVEL = 150;

// CON -> max hp, INT -> max mana.
//
// SOMET-486 demoted HP_BASE/MANA_BASE from the UNIVERSAL base to the FALLBACK
// base. A character whose class row is known contributes entity_types.max_hp /
// max_mana instead; these two are what derivePlayerStats uses when there is no
// class row, or its pool columns are NULL. They stay at 100/100 because that
// is Warrior's base and Warrior is what every character predating 486 is --
// see the migration 1714440509000 header for the three classes' numbers.
const HP_BASE = 100;
const HP_PER_CON = 10;

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

// XP curve. xpToNext(level) = round(XP_BASE * level^XP_EXPONENT), so the
// cumulative floor has NO closed form and is precomputed as a 150-entry table
// in playerStats.js. Cost of a level: 18 at 1, 45 at 2, 385 at 10, 3273 at 50,
// 8228 at 100, 14108 at 150. Cumulative to 50 is 68,598 (down from 122,500
// under the old linear curve) and to 150 is 901,212.
//
// THIS IS NOT A game_settings KEY, deliberately (design doc section 3.5).
// Changing it re-levels every character in the database on the next read; an
// admin toggling a number in a form must not be able to do that.
const XP_BASE = 18;
const XP_EXPONENT = 1.33;

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

// RETIRED as the live respec cost (SOMET-475). The cost is now
// gameSettings.respec_base_gold x level -- an ADMIN-TUNABLE setting, read by
// passiveTreeStore.respecPassives/respecQuote. Nothing in src/ reads the
// constant below any more.
//
// It is kept only because gameSettings.DEFAULTS.respec_base_gold must keep
// matching it: a fresh database with no game_settings row falls back to that
// default, and if the two ever disagreed the "unconfigured" cost would
// silently differ from the documented one. progression_store.test.js's
// hand-written 200 (50 x level 4) is written against the SETTING, not this.
// Do not reintroduce a read of it -- that is the RESPEC_BASE drift
// CharacterSheet.jsx's F2 header describes, from the other side.
const RESPEC_BASE = 50;

module.exports = {
  BASE_STAT, STAT_KEYS, MAX_LEVEL,
  HP_BASE, HP_PER_CON, MANA_BASE, MANA_PER_INT,
  MELEE_PER_STR, SPELL_PER_INT, HASTE_PER_DEX, MIN_COOLDOWN_MULT,
  MANA_REGEN_BASE, MANA_REGEN_PER_WIS,
  PRICE_PER_CHA, SELL_FRACTION_BASE, SELL_FRACTION_MAX,
  XP_BASE, XP_EXPONENT, XP_KILL_BASE, XP_LEVEL_DIFF_SLOPE, XP_LEVEL_DIFF_MAX,
  DEATH_PENALTY_MIN, DEATH_PENALTY_MAX, RESPEC_BASE,
};
