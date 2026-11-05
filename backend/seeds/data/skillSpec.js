// backend/seeds/data/skillSpec.js
//
// The numbers behind every skill, in one pure module with no I/O. Three consumers
// share it so they cannot drift apart:
//   * seeds/data/skills.js   applies the cooldown / cost rebalance to the catalog
//     (and so, via the generated copy, to the client);
//   * src/authority/skillBalance.js   turns a skill into a damage number;
//   * the description generator   quotes the same numbers back to the player.
//
// WHY THIS EXISTS. Skill damage used to be (6 + lvl*0.12) * (1 + 0.45*ln(cd)),
// clamped to 30. That is flat in level, so a level-50 skill hit like a level-5
// one while weapons grow x14 over the same range, and it paid a long cooldown with
// a logarithm while charging for it linearly (a 90 s ultimate had 0.3 dps).
// Skills must be a real part of the damage budget, so they are now defined
// relative to the weapon curve the game already has (gearLadder.js).

const { GEAR_TIERS, GEAR_FAMILIES } = require('./gearLadder.js');

const WEAPONS = GEAR_FAMILIES.filter((f) => f.category === 'weapon');
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

// The average tier-1 weapon: one hit, and hits per second.
const AUTO_HIT_T1 = mean(WEAPONS.map((w) => w.damage));
const AUTO_DPS_T1 = mean(WEAPONS.map((w) => w.damage / w.cooldown));

// The weapon power multiplier at a character level: the gear ladder's `power`,
// interpolated between its rungs. Level 1 = 1.0, level 40 = 3.4, level 55 = 4.6.
function powerAtLevel(level) {
  const lvl = Math.max(1, Number(level) || 1);
  const t = GEAR_TIERS;
  if (lvl <= t[0].req_level) return t[0].power;
  for (let i = 1; i < t.length; i += 1) {
    if (lvl <= t[i].req_level) {
      const a = t[i - 1], b = t[i];
      return a.power + ((lvl - a.req_level) / (b.req_level - a.req_level)) * (b.power - a.power);
    }
  }
  return t[t.length - 1].power;
}

const autoHitAt = (level) => AUTO_HIT_T1 * powerAtLevel(level);
const autoDpsAt = (level) => AUTO_DPS_T1 * powerAtLevel(level);

// ---- cooldowns --------------------------------------------------------------
// Skills were too slow to be a rotation: a median 8 s, up to 90 s. The cooldown
// is now cd^0.78, which roughly halves the middle (8 -> 5, 15 -> 8, 30 -> 14) and
// is gentler on the short ones (4 -> 3, 2 -> 2), floored at 1 s. A channelled
// skill (cooldown 0) stays 0. Buffs are NOT touched here: a shorter buff
// cooldown is more uptime, which is a separate decision (BUFF_TUNING below).
function rebalanceCooldown(cd) {
  const n = Number(cd);
  if (!(n > 0)) return 0;
  return Math.max(1, Math.round(n ** 0.78));
}

// ---- damage -----------------------------------------------------------------
// How much stronger than plain auto-attacking a skill is, per second of its own
// cooldown: x1.5. A long cooldown buys a bigger single hit, not a better rate,
// so the ratio eases off for very long ones (they also carry the heavy effects).
const SKILL_POWER_RATIO = 1.5;
const LONG_COOLDOWN_RATIO = 1.25;
const RATIO_EASE_FROM_S = 8;
const RATIO_EASE_TO_S = 30;
// A channelled skill ticks this often (the client's rate; the server floor is a
// little under it, skillBalance.CHANNEL_GAP_MS).
const CHANNEL_TICK_S = 0.25;

function powerRatio(periodS) {
  if (periodS <= RATIO_EASE_FROM_S) return SKILL_POWER_RATIO;
  if (periodS >= RATIO_EASE_TO_S) return LONG_COOLDOWN_RATIO;
  const t = (periodS - RATIO_EASE_FROM_S) / (RATIO_EASE_TO_S - RATIO_EASE_FROM_S);
  return SKILL_POWER_RATIO + t * (LONG_COOLDOWN_RATIO - SKILL_POWER_RATIO);
}

// Damage of ONE cast before stat and tree multipliers and before the weapon share:
// what a character wielding the level's average weapon would do auto-attacking for
// the skill's cooldown, times the power ratio. For a channelled skill it is ONE TICK.
// `skill.reqLvl` is the gem's level requirement (seeds/data/skills.js).
function castDamage(skill) {
  const lvl = Number(skill.reqLvl) || 1;
  const channeled = !!skill.channeled;
  const period = channeled ? CHANNEL_TICK_S : Math.max(1, Number(skill.cooldown) || 1);
  const raw = autoDpsAt(lvl) * period * powerRatio(period);
  return Math.max(4, raw);
}

// The same, expressed in average weapon hits of the skill's level. This is the
// player-facing unit ("deals about 6x weapon damage").
function castInWeaponHits(skill) {
  return castDamage(skill) / autoHitAt(Number(skill.reqLvl) || 1);
}

module.exports = {
  AUTO_HIT_T1, AUTO_DPS_T1, powerAtLevel, autoHitAt, autoDpsAt,
  rebalanceCooldown, castDamage, castInWeaponHits, powerRatio,
  SKILL_POWER_RATIO, LONG_COOLDOWN_RATIO, CHANNEL_TICK_S,
};

// ---- buff economy --------------------------------------------------------------
// Catalog edits for buff skills. Two rules the catalog broke:
//   1. nothing is free forever: a buff that costs nothing and recasts every second
//      is not a decision, it is a permanent stat (+25% damage for 0 mana);
//   2. a buff may not come back before it ends (uptime <= 100%) unless it is a
//      shapeshift / long mark / one-shot -- `enforceBuffUptime` below.
// `cost` follows the skill's costType (HP costs are a percent of max life).
const BUFF_TUNING = Object.freeze({
  // were free and permanent
  cul_blood_pact: { cost: 6, cooldown: 60 },
  cul_martyrdom_aura: { cost: 6, cooldown: 60 },
  arc_tailwind_aura: { cost: 25, cooldown: 60 },
  dru_thorns_aura: { cost: 25, cooldown: 60 },
  mnk_fast_mana_aura: { cost: 12, cooldown: 30 },
  mag_mana_shield: { cost: 25, cooldown: 30 },
  war_bloodlust_stance: { cost: 20, cooldown: 30 },
  cul_undead_resilience: { cost: 6, cooldown: 60 },
  war_last_stand: { cost: 25 },
  // cooldown was shorter than the duration: more than 100% uptime
  mnk_drunken_brawler_stance: { cooldown: 30 },
  mnk_tiger_stance: { cooldown: 30 },
  arc_sniper_stance: { cooldown: 30 },
  dru_rejuvenation: { cooldown: 12 },
  mag_elemental_focus: { cooldown: 30 },
  // too weak / too slow for what they give
  dru_tranquility: { cost: 40, cooldown: 45 },
  mnk_touch_of_life: { cooldown: 10 },
  mnk_inner_peace: { cooldown: 20 },
  war_unstoppable: { cooldown: 30 },
  mag_ethereal_form: { cooldown: 30 },
  war_iron_will: { cooldown: 30 },
  arc_camouflage: { cooldown: 25 },
  arc_hunters_instinct: { cooldown: 25 },
});

// A flat HP cost authored for a ~100 HP character, as a percent of max life.
function hpCostPercent(flat) {
  return Math.min(12, Math.max(3, Math.round((Number(flat) || 0) / 4)));
}

// The HP cost of a DAMAGING skill, as a percent of max life, from how often it is
// cast: a quick filler costs little, a long-cooldown nuke more. A channel pays a
// small percent per tick.
function damagingHpCostPercent(cooldownS, channeled) {
  if (channeled) return 1;
  return Math.min(18, Math.max(3, Math.round(3 + (Number(cooldownS) || 1) * 0.6)));
}

// Uptime <= 100%: a buff's cooldown is at least its duration. Exempt: instants
// (duration <= 1 s), shapeshifts and other hour-long states (toggled, not timed).
function enforceBuffUptime(cooldown, durationS) {
  const d = Number(durationS) || 0;
  if (d <= 1 || d >= 600) return cooldown;
  return Math.max(cooldown, d);
}

module.exports.BUFF_TUNING = BUFF_TUNING;
module.exports.hpCostPercent = hpCostPercent;
module.exports.damagingHpCostPercent = damagingHpCostPercent;
module.exports.enforceBuffUptime = enforceBuffUptime;
