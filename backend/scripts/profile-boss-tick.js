#!/usr/bin/env node
// backend/scripts/profile-boss-tick.js
//
// SOMET-613 (profiling pass). Measures per-tick wall-clock cost attributable
// to aura processing (applyAuras / applyEnemyAuras / chargeAuraDots) and
// skill processing (per-slot cooldown decrement, telegraph, _resolveSkill)
// under a synthetic full world-boss-event load, directly against
// CreatureSim -- the exact object World.tick drives in production
// (backend/src/authority/world.js:772 -> creatures.js:1829
// CreatureSim.tick(dt, activeChunkKeys, players, now, catalogRows)).
//
// No DB, no WebSocket, no live dev stack: everything here is the same
// exported surface backend/tests/*.test.js already uses for
// CreatureSim/applyAuras/applyEnemyAuras/chargeAuraDots. Safe to re-run any
// time, including against a future balance pass, to see whether a change in
// boss/minion aura or skill counts moves the tick budget.
//
// Run from backend/:  node scripts/profile-boss-tick.js
'use strict';

const {
  CreatureSim, applyAuras, applyEnemyAuras, chargeAuraDots,
} = require('../src/authority/creatures.js');

function stubMap() { return { isWalkable: () => true, speedAt: () => 1, chunkSize: 8 }; }

function skillRow(over = {}) {
  return {
    slot: 1, skill_id: 1, name: 'Ground Slam', kind: 'slam',
    telegraph_ms: 400, cooldown_ms: 1200, radius: 90, range: 220,
    damage_mult: 1, element: null, summon_entity: null, summon_count: 1,
    vfx: null, power_scale: 1,
    ...over,
  };
}

function enemyDotAura(over = {}) {
  return {
    name: 'molten_dot', targetSide: 'enemies', radius: 260,
    damageMult: 1, defenseMult: 1, speedMult: 1,
    dotDps: 40, dotElement: 'fire', tickMs: 500,
    ...over,
  };
}

// A boss row shaped like the real per-chunk/world_boss loader would hand it
// to CreatureSim.addCreatures (see creature_skills_wiring.test.js's
// loaderCreatureRow and world_boss_phase.test.js's bossRow for the precedent
// this mirrors): one enemy-side DoT aura reaching the whole raid, two skills.
function bossRow() {
  return {
    id: 'boss', type: 'World Boss', x: 0, y: 0, hp: 50000, facing: 'S',
    home_x: null, home_y: null, level: 80, damage: 60, blocks_portal_id: null,
    defense: 30, color: '#f00', resistances: {}, faction: 'hostile', attack_element: 'fire',
    behavior_name: 'T', aggro_radius: 1200, leash_radius: 2000,
    chase_style: 'hold', preferred_range: 0, move_speed_mult: 1, damage_override: null,
    aura_names: null, aura_defs: [], behavior_gold_min: 0, behavior_gold_max: 0,
    abilities: [],
    auras: [enemyDotAura({ name: 'boss_dot', dotDps: 60, radius: 320 })],
    skills: [
      skillRow({ slot: 1, name: 'Meteor Slam', cooldown_ms: 1500, telegraph_ms: 400, radius: 100, range: 250 }),
      skillRow({ slot: 2, name: 'Nova', kind: 'nova', cooldown_ms: 2200, telegraph_ms: 600, radius: 180, range: 0 }),
    ],
  };
}

// 8 adds, each with their own (overlapping) DoT aura and one fast-cooldown
// skill -- a world-boss event's usual "boss + minion wave" shape.
function minionRow(i) {
  return {
    id: `minion${i}`, type: 'Fire Guard', x: (i % 4) * 60 - 90, y: Math.floor(i / 4) * 60 - 30,
    hp: 1700, facing: 'S', home_x: null, home_y: null, level: 70, damage: 25,
    blocks_portal_id: null, defense: 15, color: '#f80', resistances: {}, faction: 'hostile',
    attack_element: 'fire', behavior_name: 'T', aggro_radius: 500, leash_radius: 900,
    chase_style: 'hold', preferred_range: 0, move_speed_mult: 1, damage_override: null,
    aura_names: null, aura_defs: [], behavior_gold_min: 0, behavior_gold_max: 0, abilities: [],
    auras: [enemyDotAura({ name: `minion_dot_${i % 3}`, dotDps: 15, radius: 180, tickMs: 500 })],
    skills: [skillRow({
      slot: 1, name: `Slash${i}`, cooldown_ms: 1000, telegraph_ms: 250, radius: 70, range: 150,
    })],
  };
}

function player(i) {
  return {
    userId: `p${i}`, x: (i % 5) * 70 - 140, y: Math.floor(i / 5) * 70, width: 64, height: 64,
    hp: 3000, maxHp: 3000, _buff: undefined,
  };
}

// Overridable via env for stress variants, e.g.
//   MINIONS=20 PLAYERS=40 node scripts/profile-boss-tick.js
const MINIONS = Number(process.env.MINIONS) || 8;
const PLAYERS = Number(process.env.PLAYERS) || 10;
const WARMUP = Number(process.env.WARMUP) || 50;
const TICKS = Number(process.env.TICKS) || 2000;
const DT = 0.05; // seconds -- matches server.js's production default tickMs (50ms)

function buildSimRows(stripSkills) {
  const rows = [bossRow(), ...Array.from({ length: MINIONS }, (_, i) => minionRow(i))];
  return stripSkills ? rows.map((r) => ({ ...r, skills: [] })) : rows;
}

function buildPlayers() {
  return Array.from({ length: PLAYERS }, (_, i) => player(i));
}

function stats(samplesNs) {
  const sorted = Float64Array.from(samplesNs).sort();
  const n = sorted.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += sorted[i];
  const pct = (p) => sorted[Math.min(n - 1, Math.floor(p * n))];
  return {
    meanMs: sum / n / 1e6,
    p50Ms: pct(0.5) / 1e6,
    p95Ms: pct(0.95) / 1e6,
    maxMs: sorted[n - 1] / 1e6,
  };
}

function fmt(s) {
  return `mean=${s.meanMs.toFixed(4)}ms p50=${s.p50Ms.toFixed(4)}ms p95=${s.p95Ms.toFixed(4)}ms max=${s.maxMs.toFixed(4)}ms`;
}

function run() {
  const active = new Set(['0,0', '0,-1', '-1,0', '-1,-1', '1,0', '1,-1']);

  // --- [A] Full CreatureSim.tick cost: boss + 8 minions (each with an
  //     enemy-DoT aura + 1-2 skills) + a 10-player raid. The number to
  //     compare directly against the production 50ms tick budget. ---
  const simFull = new CreatureSim(stubMap(), () => 0.37);
  simFull.addCreatures(buildSimRows(false));
  const playersFull = buildPlayers();
  const fullTickNs = [];
  let nowA = 0;
  for (let t = 0; t < WARMUP + TICKS; t++) {
    nowA += DT * 1000;
    const start = process.hrtime.bigint();
    simFull.tick(DT, active, playersFull, nowA, null);
    const end = process.hrtime.bigint();
    if (t >= WARMUP) fullTickNs.push(Number(end - start));
  }

  // --- [B] Isolated aura-processing cost: the exact 3 calls CreatureSim.tick
  //     makes at creatures.js:1863/1876/1878, called directly against a
  //     same-shaped creature/player set each "tick". ---
  const simAura = new CreatureSim(stubMap(), () => 0.37);
  simAura.addCreatures(buildSimRows(false));
  const allAura = simAura.all();
  const playersAura = buildPlayers();
  const auraNs = [];
  let nowB = 0;
  for (let t = 0; t < WARMUP + TICKS; t++) {
    nowB += DT * 1000;
    const start = process.hrtime.bigint();
    const buffs = applyAuras(allAura);
    for (const c of allAura) c._buff = buffs.get(c.id) || undefined;
    const debuffs = applyEnemyAuras(allAura, playersAura);
    for (const p of playersAura) p._buff = debuffs.get(p.userId) || undefined;
    if (debuffs.size > 0) chargeAuraDots(playersAura, nowB);
    const end = process.hrtime.bigint();
    auraNs.push(Number(end - start));
  }

  // --- [C] Full tick with skills: [] on every creature -- isolates the
  //     skill-processing cost (the per-slot cooldown loop + telegraph +
  //     _resolveSkill at creatures.js:1897-2727, which is not separately
  //     exported) by diffing against [A]. ---
  const simNoSkills = new CreatureSim(stubMap(), () => 0.37);
  simNoSkills.addCreatures(buildSimRows(true));
  const playersNoSkills = buildPlayers();
  const noSkillNs = [];
  let nowC = 0;
  for (let t = 0; t < WARMUP + TICKS; t++) {
    nowC += DT * 1000;
    const start = process.hrtime.bigint();
    simNoSkills.tick(DT, active, playersNoSkills, nowC, null);
    const end = process.hrtime.bigint();
    if (t >= WARMUP) noSkillNs.push(Number(end - start));
  }

  const fullStats = stats(fullTickNs);
  const auraStats = stats(auraNs);
  const noSkillStats = stats(noSkillNs);
  const skillDeltaMeanMs = fullStats.meanMs - noSkillStats.meanMs;
  const tickBudgetMs = 50;
  const auraPlusSkillMs = auraStats.meanMs + Math.max(0, skillDeltaMeanMs);

  console.log('=== SOMET-613 boss-event tick profiling ===');
  console.log(`Scenario: 1 boss (1 DoT aura r=320 + 2 skills) + ${MINIONS} minions (each 1 DoT aura + 1 skill) + ${PLAYERS} players. dt=${DT * 1000}ms, ${TICKS} ticks measured after ${WARMUP} warmup ticks.`);
  console.log('');
  console.log(`[A] Full CreatureSim.tick (aura+skill+movement+combat, everything):      ${fmt(fullStats)}`);
  console.log(`[B] Isolated aura processing only (applyAuras+applyEnemyAuras+DoT):       ${fmt(auraStats)}`);
  console.log(`[C] Full tick with skills:[] on every creature (isolates skill cost):     ${fmt(noSkillStats)}`);
  console.log(`[C'] Skill-processing cost, mean(A) - mean(C):                            ${skillDeltaMeanMs.toFixed(4)}ms`);
  console.log('');
  console.log(`Aura + skill share of the ${tickBudgetMs}ms production tick budget (server.js default tickMs): ${auraPlusSkillMs.toFixed(4)}ms = ${((auraPlusSkillMs / tickBudgetMs) * 100).toFixed(2)}%`);
}

run();
