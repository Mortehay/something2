// World boss balance: ONE place for the numbers and for the model that proves
// they hold.
//
// DESIGN TARGET. A character in top-end gear must need at least
// MIN_FIGHT_SECONDS (2.5 minutes now, see below) of real fighting to kill a world boss. The
// fight is not a DPS check: HP, flat defense and elemental resistance are all
// high, phases add shields, and a ward refills the shield on a timer so damage
// has to come in bursts that break it, not as a slow trickle.
//
// THE MODEL (expectedFightSeconds) is deliberately simple and conservative; the
// test boss_balance.test.js pins the tuning against it, so changing a number
// here that drops the fight under five minutes fails CI instead of shipping.
//
// REFERENCE PLAYER ("top-end"). Everything here is read off the live formulas:
//   weapon        mythic-axe: 116 damage, 0.7s cooldown (best DPS in the catalog)
//   strength      320       -> meleeMult = 1 + 0.05 * (320 - 5) = 16.75
//   passive tree  +100% physical damage (x2)
//   haste         x1.5 attack rate (well under the x2.5 DEX cap)
// A hit therefore lands for 116 * 16.75 * 2 = 3886 before the boss's own
// mitigation, 2.14 times a second. Spell builds sit in the same band
// (mythic-staff 116 / 0.85s, spellMult from INT the same way).
const REFERENCE = Object.freeze({
  hit: 116 * (1 + 0.05 * (320 - 5)) * 2,
  attacksPerSecond: 1.5 / 0.7,
  // Share of the fight a player is actually dealing damage: the boss moves,
  // minions have to be cleared, and the player dodges. Generous on purpose.
  uptime: 0.6,
});

// Was 300 (5 min). Halved with the HP: top-end gear now needs at least 2.5 minutes, about
// 3 against the boss's weak element and 4 to 9 against anything else.
const MIN_FIGHT_SECONDS = 150;

// Shield granted on entering a phase, as a fraction of max HP, and the ward
// that tops it back up on a timer in phases 2+.
const PHASE_SHIELD = Object.freeze({ 2: 0.04, 3: 0.05, 4: 0.06 });
const WARD_INTERVAL_MS = 45 * 1000;
const WARD_FRACTION = 0.015;      // of max HP per ward
const SHIELD_CAP_FRACTION = 0.08; // the shield never exceeds this share of max HP

// Per boss: the catalog numbers. Resistances are fractions (0.75 = 75%), the
// engine caps them at 0.8; each boss keeps ONE weak element at 0 so a prepared
// party has a reason to bring the right damage type.
const WORLD_BOSSES = Object.freeze({
  'Ignis, the Magma Colossus': {
    hp: 440000, defense: 1500, baseDamage: 420,
    resistances: { physical: 0.3, arcane: 0.3, lightning: 0.3, fire: 0.6, ice: 0 },
  },
  'Glacius, the Frost Leviathan': {
    hp: 390000, defense: 1800, baseDamage: 350,
    resistances: { physical: 0.3, arcane: 0.3, lightning: 0.3, ice: 0.6, fire: 0 },
  },
  'Gorgon, the Thunder Titan': {
    hp: 450000, defense: 1400, baseDamage: 450,
    resistances: { physical: 0.3, fire: 0.3, ice: 0.3, lightning: 0.6, arcane: 0 },
  },
  'Abyssor, the Voidreaver': {
    hp: 500000, defense: 1500, baseDamage: 520,
    resistances: { physical: 0.3, fire: 0.3, ice: 0.3, arcane: 0.6, lightning: 0 },
  },
});

// Damage one reference hit does to a boss, through the engine's own rule
// (damage.js applyDamage): flat defense is subtracted first, then the element's
// resistance, with a floor of 1.
function hitAgainst(boss, element = 'physical') {
  const raw = REFERENCE.hit - boss.defense;
  const resist = Math.min(0.8, Math.max(-1, (boss.resistances && boss.resistances[element]) || 0));
  return Math.max(1, raw * (1 - resist));
}

// Total damage the boss can soak over the fight: its HP plus every shield it
// will have: the three phase shields and the wards over a fight of that length.
function totalToughness(boss, seconds) {
  const phaseShields = Object.values(PHASE_SHIELD).reduce((a, f) => a + f * boss.hp, 0);
  const wards = Math.floor((seconds * 1000) / WARD_INTERVAL_MS) * WARD_FRACTION * boss.hp;
  return boss.hp + phaseShields + wards;
}

// Seconds a reference player needs. Wards depend on the fight length, so this
// iterates to a fixed point (it converges in a couple of rounds).
function expectedFightSeconds(boss, element = 'physical') {
  const dps = hitAgainst(boss, element) * REFERENCE.attacksPerSecond * REFERENCE.uptime;
  let seconds = totalToughness(boss, 0) / dps;
  for (let i = 0; i < 8; i++) seconds = totalToughness(boss, seconds) / dps;
  return seconds;
}

// Which phase an HP ratio is in (75 / 50 / 25 %), the same thresholds the world
// boss event uses.
function phaseForRatio(ratio) {
  if (ratio <= 0.25) return 4;
  if (ratio <= 0.5) return 3;
  if (ratio <= 0.75) return 2;
  return 1;
}

function addShield(creature, fraction) {
  if (!creature || !(fraction > 0)) return;
  const cap = creature.maxHp * SHIELD_CAP_FRACTION;
  creature.shield = Math.min(cap, (creature.shield || 0) + creature.maxHp * fraction);
}

// One step of the endurance rules for a boss that is NOT managed by the world
// boss event (a post boss). `state` is { phase, lastWardAt } kept by the owner.
// Returns { phase, phaseChanged, warded } so the caller can announce.
function enduranceStep(state, creature, now) {
  const phase = phaseForRatio(creature.hp / (creature.maxHp || 1));
  let phaseChanged = false;
  let warded = false;
  if (phase > state.phase) {
    state.phase = phase;
    phaseChanged = true;
    addShield(creature, PHASE_SHIELD[phase] || 0);
    state.lastWardAt = now;
  } else if (state.phase >= 2) {
    if (state.lastWardAt == null) state.lastWardAt = now;
    if (now - state.lastWardAt >= WARD_INTERVAL_MS) {
      state.lastWardAt = now;
      addShield(creature, WARD_FRACTION);
      warded = true;
    }
  }
  return { phase: state.phase, phaseChanged, warded };
}

module.exports = {
  phaseForRatio, addShield, enduranceStep,
  REFERENCE, MIN_FIGHT_SECONDS, PHASE_SHIELD, WARD_INTERVAL_MS, WARD_FRACTION, SHIELD_CAP_FRACTION,
  WORLD_BOSSES, hitAgainst, totalToughness, expectedFightSeconds,
};
