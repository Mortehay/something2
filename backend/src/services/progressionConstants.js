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

// Stamina's base pool. No stat scales it and no class row carries it, so this
// is its whole starting value; the passive tree's `resource` grants are the
// only thing that moves it (SOMET-495).
//
// It was `PLAYER_MAX_STAMINA = 100` in authority/world.js until 495. world.js
// still exports that name -- several tests import it -- but it is now an alias
// for this constant rather than a second copy of the number, so the pool a
// player joins with and the pool derivePlayerStats computes cannot drift.
const STAMINA_BASE = 100;

// STR -> physical damage, INT -> every other element. The split is the
// weapon's existing `element` column; no new field.
const MELEE_PER_STR = 0.05;
const SPELL_PER_INT = 0.05;

// DEX -> attack speed, as a cooldown MULTIPLIER (lower is faster). The floor
// exists because the multiplier is 1/(1+k*n): without it a high enough DEX
// approaches a zero cooldown, i.e. an unbounded attack rate.
const HASTE_PER_DEX = 0.03;
const MIN_COOLDOWN_MULT = 0.4;

// SOMET-521. The angle between adjacent projectiles in a multi-shot volley,
// in radians (~9 degrees). A volley is fanned symmetrically about the aim
// vector, so three shots are centre/left/right rather than three stacked on
// one line -- which is what makes +2 projectiles read as a spread rather than
// as one thicker arrow.
const PROJECTILE_FAN_RAD = 0.16;

// SOMET-522. The leech aura (the Cultist's Sanguine Aura cluster).
//
// AURA_MAX_TARGETS is the balance, not a performance guard. The aura heals per
// hostile creature standing inside it, and a world can hold 12-creature packs
// -- uncapped, walking into a pack would be unkillable sustain. Six is the
// most a single node may be worth.
// SOMET-528. The lingering arc wave: a swing that keeps damaging the ground
// it swept for a couple of seconds.
//
// WAVE_MAX_STACKS IS THE BALANCE, NOT A NICETY -- the same role AURA_MAX_TARGETS
// plays for the aura. Waves STACK (a deliberate product decision), and
// attackSpeedMult is itself a tree option, so a fast attacker lays waves faster
// than they expire. Without the cap, wave damage scales with attack speed
// without bound. With it, a player's total wave output is capped no matter how
// fast they swing.
const WAVE_DURATION_S = 2;
const WAVE_MAX_STACKS = 3;
// Resolved once a second, like the aura, so the authored share is
// damage-per-second and does not scale with tick rate.
const WAVE_INTERVAL_S = 1;

// SOMET-527. Floors for a melee swing's geometry.
//
// meleeReachBonus and meleeArcBonus are both `sum`, which is what lets a shape
// node NARROW or SHORTEN a swing by authoring a negative -- Spearpoint trades
// arc for reach, Sweep trades reach for arc. Without a floor, stacking
// negatives produces a swing that cannot hit anything (reach <= 0) or one whose
// half-angle is negative, which makes inArc's cos(arc/2) comparison
// meaningless rather than merely narrow.
//
// MIN_MELEE_REACH is set so a floored swing still reaches a creature standing
// against you: a creature is 48px and measurement is centre-to-centre.
const MIN_MELEE_REACH = 48;
// ~17 degrees. Narrow enough to be a real drawback, wide enough to remain a
// usable weapon rather than a bug report.
const MIN_MELEE_ARC = 0.3;

const AURA_BASE_RADIUS = 120;
const AURA_MAX_TARGETS = 6;
// The aura resolves once a second rather than per frame, so its cost does not
// scale with tick rate and its numbers are authored in life-per-second.
const AURA_INTERVAL_S = 1;

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
  HP_BASE, HP_PER_CON, MANA_BASE, MANA_PER_INT, STAMINA_BASE,
  MELEE_PER_STR, SPELL_PER_INT, HASTE_PER_DEX, MIN_COOLDOWN_MULT,
  PROJECTILE_FAN_RAD, AURA_BASE_RADIUS, AURA_MAX_TARGETS, AURA_INTERVAL_S,
  MIN_MELEE_REACH, MIN_MELEE_ARC,
  WAVE_DURATION_S, WAVE_MAX_STACKS, WAVE_INTERVAL_S,
  MANA_REGEN_BASE, MANA_REGEN_PER_WIS,
  PRICE_PER_CHA, SELL_FRACTION_BASE, SELL_FRACTION_MAX,
  XP_BASE, XP_EXPONENT, XP_KILL_BASE, XP_LEVEL_DIFF_SLOPE, XP_LEVEL_DIFF_MAX,
  DEATH_PENALTY_MIN, DEATH_PENALTY_MAX, RESPEC_BASE,
};
