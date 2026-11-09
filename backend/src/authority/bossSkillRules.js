// Which skill a world boss throws at the beats of its fight, beyond the ordinary
// cooldown rotation. Pure data + two lookups, no sim and no clock.
//
//  * PHASE_SKILLS: the signature attack the boss throws the moment it ENTERS a phase
//    (queued by worldBoss.js _stepPhase; the sim casts it ahead of the rotation, ignoring
//    cooldown and range). Phase 3 opens with the boss's second-tier mechanic, phase 4 with
//    its ultimate, so each boss's phase change is felt differently, not just as bigger numbers.
//  * WARD_SKILLS: what comes with each Ward (every WARD_INTERVAL_MS from phase 2): the
//    shield is topped up AND the boss answers with this attack, so a long fight keeps
//    producing a threat the damage-in-bursts rule has to be played around.
//
// A name that no longer matches a bound skill is dropped by the sim (takeQueuedSkill), so
// renaming a skill costs the cue and nothing else. The kits themselves are in
// migrations/1714440874000_world_boss_distinct_kits.js; boss_distinct_kits.test.js pins that
// every name here is one the boss owns.
const PHASE_SKILLS = Object.freeze({
  'Ignis, the Magma Colossus': Object.freeze({ 3: 'Scorched Earth', 4: 'Meltdown' }),
  'Glacius, the Frost Leviathan': Object.freeze({ 3: 'Frost Field', 4: 'Absolute Zero' }),
  'Gorgon, the Thunder Titan': Object.freeze({ 3: 'Static Charge', 4: 'Thunderstorm' }),
  'Abyssor, the Voidreaver': Object.freeze({ 3: 'Gravity Well', 4: 'Reality Tear' }),
});

const WARD_SKILLS = Object.freeze({
  'Ignis, the Magma Colossus': 'Lava Pools',
  'Glacius, the Frost Leviathan': 'Flash Freeze',
  'Gorgon, the Thunder Titan': 'Chain Lightning',
  'Abyssor, the Voidreaver': 'Mind Rend',
});

function phaseSkillFor(bossName, phase) {
  const byPhase = PHASE_SKILLS[bossName];
  return (byPhase && byPhase[phase]) || null;
}

function wardSkillFor(bossName) {
  return WARD_SKILLS[bossName] || null;
}

module.exports = { PHASE_SKILLS, WARD_SKILLS, phaseSkillFor, wardSkillFor };
