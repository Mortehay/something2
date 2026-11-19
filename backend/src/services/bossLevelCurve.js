// Dungeon boss level curve (SOMET-630): how an Elite or End boss's hp, damage and defense
// grow with its level, measured against the player a boss of that level is meant for.
//
// WHY NOT creatureLevel.scaleCreature. That curve is linear (+15% hp, +10% damage,
// +0.5 defense per level) and was written before player progression existed. Player
// damage is not linear: it jumps at every gear tier (gearLadder.js `power` 1 -> 14.5)
// and grows with strength on top. Measured against the reference player below, the old
// curve had the Umbral Gatekeeper (level 50) hitting for 698 against 450 hp -- a one-shot
// -- while the Bone Regent (level 7) took five minutes to kill. Ordinary creatures and
// boss minions keep scaleCreature; only the boss itself uses this.
//
// THE TARGETS (approved 2026-11-19), for a solo player AT the boss's level in that
// level's gear:
//   dungeon_end    time to kill 90-150 s,  time to die >= 8 s
//   dungeon_elite  time to kill 45-90 s,   time to die >= 12 s
// The reference is aimed at the middle of each band (TARGETS below). The test
// boss_level_curve.test.js walks every boss post in the shipped map specs and checks
// both numbers for the row actually placed there, with its own resistances.
//
// THE REFERENCE PLAYER is deliberately plain, and read off the live formulas and the
// authored gear ladder rather than copied numbers:
//   weapon    the ladder sword of the highest tier the level may wear
//             (gearLadder: damage 7 x tier power, cooldown 0.6 s)
//   strength  10 + 2 per level (base 5, a point a level, about half the tree on STR)
//             -> meleeMult = 1 + 0.05 * (STR - 5)          (playerStats.js)
//   haste     base dexterity's cooldown cut, x1/1.15
//   hp        150 + 6 per level
//   defense   the heavy set of that tier: plate, helm, gauntlets, greaves, buckler,
//             both rings (8.6 x tier power)
// No passive damage %, no affixes, no skills: a build that has them kills faster.
//
// THE BOSS'S HIT is its sustained basic attack (bossAI phase 1): an End boss's Apex
// slam 1.4x every 1.2 s, an Elite's Champion swing 1.0x every 1.1 s. Telegraphed pool
// attacks are dodgeable and are not counted.
//
// HOW A ROW SCALES. A row's authored hp / base_damage / defense are its LEVEL-1 values;
// at level L each is multiplied by reference(L) / reference(1) for the row's tier. A row
// authored at the tier's reference therefore lands on the target at every level, and an
// admin who doubles a row's hp doubles it at every level -- the knob still works.
const { GEAR_TIERS, GEAR_FAMILIES } = require('../../seeds/data/gearLadder.js');

const TARGETS = Object.freeze({
  dungeon_end: Object.freeze({ ttkSeconds: 120, ttdSeconds: 10, hitMult: 1.4, cooldownS: 1.2 }),
  dungeon_elite: Object.freeze({ ttkSeconds: 67, ttdSeconds: 15, hitMult: 1.0, cooldownS: 1.1 }),
});
// Boss defense as a share of the reference player's hit: enough to matter, never so much
// that the player's hit falls to the damage floor.
const DEFENSE_SHARE = 0.25;
// The resistance the reference boss carries to the player's physical hit (the shipped
// rows hold 0.2-0.4).
const REFERENCE_RESIST = 0.3;
const MAX_LEVEL = 150;

const family = (key) => GEAR_FAMILIES.find((f) => f.key === key);
const HEAVY_SET = ['plate', 'helm', 'gauntlets', 'greaves', 'buckler', 'band', 'signet'];

function tierFor(level) {
  let t = GEAR_TIERS[0];
  for (const g of GEAR_TIERS) if (g.req_level <= level) t = g;
  return t;
}

const clampLevel = (level) => (Number.isInteger(level) && level >= 1 ? Math.min(level, MAX_LEVEL) : 1);

// The reference player at `level`. Plain numbers; see the header for each one.
function referencePlayer(level) {
  const L = clampLevel(level);
  const tier = tierFor(L);
  const sword = family('sword');
  const strength = 10 + 2 * L;
  const hit = sword.damage * tier.power * (1 + 0.05 * (strength - 5));
  const attacksPerSecond = 1.15 / sword.cooldown;
  const defense = HEAVY_SET.reduce((sum, k) => sum + family(k).defense, 0) * tier.power;
  return { level: L, tier: tier.prefix, hit, attacksPerSecond, hp: 150 + 6 * L, defense };
}

// Damage after flat defense then resistance, floored at 1 -- authority/damage.js's order.
function mitigated(raw, defense, resist = 0) {
  return Math.max(1, (raw - defense) * (1 - resist));
}

// The stats a boss of `tier` at `level` needs to land on the middle of its targets.
function referenceBoss(tier, level) {
  const t = TARGETS[tier];
  if (!t) throw new Error(`no level curve for boss tier "${tier}"`);
  const p = referencePlayer(level);
  const defense = DEFENSE_SHARE * p.hit;
  const playerDps = mitigated(p.hit, defense, REFERENCE_RESIST) * p.attacksPerSecond;
  const hp = t.ttkSeconds * playerDps;
  // The net hit that empties the player's hp in ttdSeconds, then back through their defense.
  const netHit = p.hp / (t.ttdSeconds / t.cooldownS);
  const damage = (netHit + p.defense) / t.hitMult;
  return { hp, damage, defense };
}

const round2 = (n) => Math.round(n * 100) / 100;

// A dungeon boss row's stats at `level`. `base` holds the row's authored LEVEL-1 values.
// Same shape as creatureLevel.scaleCreature, so the caller can switch between the two.
function scaleBoss(base, tier, level) {
  const one = referenceBoss(tier, 1);
  const at = referenceBoss(tier, clampLevel(level));
  return {
    hp: Math.max(1, Math.round((Number(base.hp) || 0) * (at.hp / one.hp))),
    damage: round2((Number(base.damage) || 0) * (at.damage / one.damage)),
    defense: round2((Number(base.defense) || 0) * (at.defense / one.defense)),
  };
}

// The level-1 values a row of `tier` is authored with to sit on the reference curve.
function referenceBase(tier) {
  const r = referenceBoss(tier, 1);
  // hp is an integer column; base_damage and defense are real, so they keep 2dp and the
  // level ratio in scaleBoss starts from the exact reference.
  return { hp: Math.round(r.hp), base_damage: round2(r.damage), defense: round2(r.defense) };
}

module.exports = {
  TARGETS, DEFENSE_SHARE, REFERENCE_RESIST, MAX_LEVEL,
  referencePlayer, referenceBoss, scaleBoss, referenceBase, mitigated,
};
