// Amber Stance, Task 3: a sealed player is untargetable and unharmed.
//
// Every harm test pairs a SEALED player with an unsealed CONTROL standing in
// the same spot (or on the same line), so a pass cannot come from the attack
// simply missing: the control proves the attack landed where the sealed
// player stands. Pure in-memory: stub maps, no DB.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { seal, setAmberConfig } = require('../src/authority/amber.js');
const { applyDamage, applyDamageWithEffects } = require('../src/authority/damage.js');
const E = require('../src/authority/effects.js');
const { shoveAwayFrom } = require('../src/authority/knockback.js');
const { CreatureSim, chargeAuraDots, AGGRO_RADIUS } = require('../src/authority/creatures.js');
const { ProjectileSim } = require('../src/authority/projectiles.js');
const { World } = require('../src/authority/world.js');
const skillBalance = require('../src/authority/skillBalance.js');

setAmberConfig({ maxMs: 30000, afterReadyMs: 10000, variants: [] });

const NOW = 1000;
const ACTIVE = new Set(['0,0', '0,1', '1,0', '1,1']);
const openMap = () => ({ chunkSize: 8, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] });
const player = (userId, x = 200, y = 200) => ({ userId, x, y, width: 64, height: 64, hp: 1000, maxHp: 1000 });
// A sealed player and an unsealed control, side by side at the same spot.
function pair(x = 200, y = 200) {
  const s = player('sealed', x, y);
  const c = player('control', x, y);
  seal(s, NOW);
  return { s, c };
}

test('applyDamage on sealed deals nothing', () => {
  const { s, c } = pair();
  assert.equal(applyDamage(s, 50, 'fire', undefined, NOW, 'c:x'), 0);
  assert.equal(applyDamageWithEffects(s, 50, 'fire', undefined, NOW, 'c:x'), 0);
  assert.equal(s.hp, 1000);
  assert.equal(s._provokedBy, undefined, 'no provocation stamped');
  assert.ok(applyDamage(c, 50, 'fire', undefined, NOW, 'c:x') > 0);
  assert.ok(c.hp < 1000);
});

test('applyDamage without a clock still spares a sealed player (fails closed)', () => {
  const { s, c } = pair();
  applyDamage(s, 50, 'physical');
  applyDamage(c, 50, 'physical');
  assert.equal(s.hp, 1000);
  assert.ok(c.hp < 1000);
});

test('dot ticks deal nothing: a burn applied before sealing ticks only on the control', () => {
  const w = new World(openMap(), new Map(), null);
  w.now = NOW;
  w.addPlayer('sealed', { x: 200, y: 200 });
  w.addPlayer('control', { x: 200, y: 200 });
  const s = w.getPlayer('sealed');
  const c = w.getPlayer('control');
  E.applyElementEffect(s, 'fire', w.now, null);
  E.applyElementEffect(c, 'fire', w.now, null);
  seal(s, w.now);
  const hs = s.hp, hc = c.hp;
  for (let i = 0; i < 40; i++) w.tick(0.05); // 2 s
  assert.equal(s.hp, hs, 'sealed hp unchanged');
  assert.ok(c.hp < hc, 'control burned');
});

test('aura ticks deal nothing: chargeAuraDots spares the sealed player', () => {
  const { s, c } = pair();
  const debuff = () => ({
    damageMult: 1, defenseMult: 1, speedMult: 1,
    auras: [{ name: 'Scorch', damageMult: 1, defenseMult: 1, speedMult: 1, dotDps: 20, dotElement: 'fire', tickMs: 1000, sourceId: 'boss' }],
  });
  s._buff = debuff();
  c._buff = debuff();
  chargeAuraDots([s, c], NOW);
  chargeAuraDots([s, c], NOW + 1000);
  assert.equal(s.hp, 1000);
  assert.ok(c.hp < 1000);
});

test('an enemy aura creature does not debuff a sealed player in CreatureSim.tick', () => {
  const sim = new CreatureSim(openMap(), () => 0.5);
  sim.addCreatures([{
    id: 'a', type: 'Shaman', x: 200, y: 200, hp: 100, facing: 'S', color: '#c00',
    auras: [{ name: 'Scorch', targetSide: 'enemies', radius: 400, damageMult: 0.5, defenseMult: 0.5, speedMult: 0.5, dotDps: 20, dotElement: 'fire', tickMs: 1000 }],
  }]);
  const { s, c } = pair(230, 200);
  sim.tick(0.05, ACTIVE, [s, c], NOW);
  assert.equal(s._buff.auras, undefined, 'sealed player carries no enemy-aura debuff');
  assert.equal(s.hp, 1000);
  assert.ok(Array.isArray(c._buff.auras), 'control is debuffed');
  assert.ok(c.hp < 1000, 'control took the aura dot');
});

test('harmful statuses do not land', () => {
  const { s, c } = pair();
  for (const t of [s, c]) {
    E.applyStun(t, 2000, NOW);
    E.applySlow(t, 50, 2000, NOW, 'x');
    E.applyCharm(t, 'druid', NOW);
  }
  assert.equal(E.activeEffectKeys(s, NOW), null, 'sealed: no active key');
  assert.equal(E.isStunned(s, NOW), false);
  assert.equal(E.isStunned(c, NOW), true);
  assert.deepEqual(new Set(E.activeEffectKeys(c, NOW)), new Set([E.CHILL, E.CHARMED]));

  // The rest of the harmful appliers, same pairing.
  const { s: s2, c: c2 } = pair();
  for (const t of [s2, c2]) {
    E.applyRoot(t, 2000, NOW, 'x');
    E.applySilence(t, 2000, NOW);
    E.applyShockInterrupt(t, NOW);
    E.applyElementEffect(t, 'lightning', NOW, 'x');
    E.stampRider(t, E.STATUS_EFFECTS[E.BURN], NOW, 'x');
    E.applyHitStatuses(t, ['burn', 'chill'], NOW, 'x');
    E.applyEffect(t, E.POISON, { durationMs: 2000, magnitude: 5, sourceId: 'x', now: NOW });
    E.applyStrongest(t, E.WEAKEN, { durationMs: 2000, magnitude: 0.2, sourceId: 'x', now: NOW });
  }
  assert.equal(E.activeEffectKeys(s2, NOW), null);
  assert.equal(E.canAct(s2, NOW), true, 'no interrupt / silence');
  assert.ok(E.activeEffectKeys(c2, NOW).length >= 4);
  assert.equal(E.canAct(c2, NOW), false);
});

test('heals and buffs still land on a sealed player', () => {
  const w = new World(openMap(), new Map(), null);
  w.now = NOW;
  w.addPlayer('healer', { x: 200, y: 200 });
  w.addPlayer('sealed', { x: 220, y: 200 });
  const h = w.getPlayer('healer');
  const s = w.getPlayer('sealed');
  seal(s, w.now);
  s.hp = 10;
  h.hp = h.maxHp;
  w._castSpecial(h, { transfuse: 0.2 }, 0, 0); // Life Transfusion: heal the nearest ally
  assert.equal(s.hp, s.maxHp, 'an ally heal raises the sealed player');
  assert.ok(skillBalance.grantTimedBuff(s, { id: 'boon', nameEn: 'Boon', nameUk: 'Boon' }, { dealt: 0.1 }, 5000, w.now));
  assert.ok(s.buffs.has('boon'), 'a buff from someone else is applied');
});

test('knockback does not move sealed', () => {
  const map = openMap();
  const { s, c } = pair();
  shoveAwayFrom(map, 150, 232, s, 80);
  shoveAwayFrom(map, 150, 232, c, 80);
  assert.deepEqual([s.x, s.y], [200, 200]);
  assert.ok(c.x > 200, 'control was shoved');
});

test('creature ignores sealed in aggro, and targets them once unsealed', () => {
  const sim = new CreatureSim(openMap(), () => 0.5);
  sim.addCreatures([{ id: 'a', type: 'Wolf', x: 100, y: 100, hp: 100, facing: 'S', color: '#c00' }]);
  const s = player('sealed', 100 + AGGRO_RADIUS - 50, 100);
  seal(s, NOW);
  sim.tick(0.05, ACTIVE, [s], NOW);
  assert.equal(sim.get('a')._target, null, 'a sealed player is never acquired');
  s.amber = null;
  sim.tick(0.05, ACTIVE, [s], NOW + 50);
  assert.equal(sim.get('a')._target, 'sealed', 'acquired once unsealed');
});

test('creature ignores the sealed one but takes the control in the same spot', () => {
  const sim = new CreatureSim(openMap(), () => 0.5);
  sim.addCreatures([{ id: 'a', type: 'Wolf', x: 100, y: 100, hp: 100, facing: 'S', color: '#c00' }]);
  const { s, c } = pair(130, 100);
  sim.tick(0.05, ACTIVE, [c, s], NOW); // sealed last: the `<=` tie-break would pick it
  assert.equal(sim.get('a')._target, 'control');
  assert.equal(s.hp, 1000);
});

test('creature drops a sealed target', () => {
  const sim = new CreatureSim(openMap(), () => 0.5);
  sim.addCreatures([{ id: 'a', type: 'Wolf', x: 100, y: 100, hp: 100, facing: 'S', color: '#c00' }]);
  const p = player('u1', 250, 100);
  sim.tick(0.05, ACTIVE, [p], NOW);
  assert.equal(sim.get('a')._target, 'u1', 'precondition: acquired');
  seal(p, NOW + 50);
  sim.tick(0.05, ACTIVE, [p], NOW + 50);
  assert.equal(sim.get('a')._target, null);
});

function bossSim(kind, over = {}) {
  const sim = new CreatureSim(openMap(), () => 0.5);
  sim.addCreatures([{
    id: 'boss', type: 'Boss', x: 0, y: 0, hp: 1e6, facing: 'S', home_x: null, home_y: null, level: 1, damage: 10,
    blocks_portal_id: null, defense: 0, color: '#fff', resistances: {}, faction: 'hostile', attack_element: 'fire',
    behavior_name: 'Boss', aggro_radius: 900, leash_radius: 2000, chase_style: 'hold', preferred_range: 0,
    move_speed_mult: 1, damage_override: null, aura_names: null, aura_defs: [],
    behavior_gold_min: 0, behavior_gold_max: 0, abilities: [],
    skills: [{
      slot: 1, skill_id: 1, name: 'Slam', kind, telegraph_ms: 500, cooldown_ms: 60000, radius: 400, range: 800,
      damage_mult: 1, element: 'fire', summon_entity: null, summon_count: 1,
      vfx: { telegraph: 't', cast: 'c', impact: 'i' }, power_scale: 1, params: null, min_phase: 1, requires_enrage: false,
      ...over,
    }],
  }]);
  return sim;
}

test('boss area skill skips sealed', () => {
  const sim = bossSim('nova');
  const { s, c } = pair(200, 0);
  sim.tick(0, ACTIVE, [s, c], NOW); // telegraph (targets the control)
  const out = sim.tick(0.5, ACTIVE, [s, c], NOW + 500); // resolve
  assert.equal(s.hp, 1000, 'sealed untouched');
  assert.ok(c.hp < 1000, 'control hit');
  assert.ok(out.impacts.some((i) => i.t === 'p:control'));
  assert.ok(!out.impacts.some((i) => i.t === 'p:sealed'), 'no impact entry for the sealed player');
});

test('boss area skill skips sealed even when the sealed player was the telegraphed target', () => {
  const sim = bossSim('nova');
  const s = player('sealed', 200, 0);
  const c = player('control', 200, 0);
  sim.tick(0, ACTIVE, [s, c], NOW); // both unsealed at telegraph time
  seal(s, NOW + 100);
  const out = sim.tick(0.5, ACTIVE, [s, c], NOW + 500);
  assert.equal(s.hp, 1000);
  assert.ok(c.hp < 1000);
  assert.ok(!out.impacts.some((i) => i.t === 'p:sealed'));
});

test('hazard ground spares the sealed player', () => {
  const sim = new CreatureSim(openMap(), () => 0.5);
  sim.hazards.push({ id: 1, ownerId: 'boss', x: 232, y: 232, r: 200, inner: 0, until: NOW + 5000, tickMs: 500, nextAt: new Map(), dmg: 30, element: 'fire', slowPct: 50, v: 'v', impactV: 'i' });
  const { s, c } = pair();
  const out = sim.tick(0.05, ACTIVE, [s, c], NOW);
  assert.equal(s.hp, 1000);
  assert.equal(E.activeEffectKeys(s, NOW), null, 'no hazard slow either');
  assert.ok(c.hp < 1000);
  assert.ok(!out.impacts.some((i) => i.t === 'p:sealed'));
});

test('projectile passes through a sealed player and hits the control behind', () => {
  const sim = new ProjectileSim();
  sim.spawn({
    ownerId: 'c', ownerKind: 'creature', ownerFaction: 'hostile', x: 0, y: 32, nx: 1, ny: 0, damage: 20,
    weapon: { projectile_speed: 1000, projectile_radius: 6, range: 1000, pierce: 1, aoe_radius: 0, element: 'physical', damage: 20 },
  });
  const s = player('sealed', 100, 0);
  const c = player('control', 300, 0);
  seal(s, NOW);
  const creatures = { all: () => [], damageCreatureById: () => false };
  for (let i = 0; i < 10; i++) sim.step(0.05, { creatures, players: [s, c], map: openMap(), now: NOW + i * 50 });
  assert.equal(s.hp, 1000, 'sealed untouched');
  assert.ok(c.hp < 1000, 'the shot flew on and hit the control');
});

test('an AoE detonation spares the sealed player', () => {
  const sim = new ProjectileSim();
  sim.spawn({
    ownerId: 'c', ownerKind: 'creature', ownerFaction: 'hostile', x: 0, y: 32, nx: 1, ny: 0, damage: 20,
    weapon: { projectile_speed: 1000, projectile_radius: 6, range: 1000, pierce: 1, aoe_radius: 150, element: 'physical', damage: 20, detonate_at: 'contact' },
  });
  const s = player('sealed', 120, 0);
  const c = player('control', 140, 0);
  seal(s, NOW);
  const creatures = { all: () => [], damageCreatureById: () => false };
  for (let i = 0; i < 10; i++) sim.step(0.05, { creatures, players: [s, c], map: openMap(), now: NOW + i * 50 });
  assert.equal(s.hp, 1000);
  assert.ok(c.hp < 1000);
});

const DAGGER = { id: 1, name: 'dagger', category: 'weapon', kind: 'melee', damage: 8, cooldown: 0.3, reach: 120, arc_width: 1.2, mana_cost: 0, element: null };

test('pvp skips sealed: canHurtPlayer is false and a melee swing hits only the control', () => {
  const w = new World(openMap(), new Map([[1, DAGGER]]), 1);
  w.now = NOW;
  w.addPlayer('a', { x: 200, y: 200 });
  w.addPlayer('sealed', { x: 250, y: 200 });
  w.addPlayer('control', { x: 250, y: 200 });
  const s = w.getPlayer('sealed');
  const c = w.getPlayer('control');
  seal(s, w.now);
  assert.equal(w.canHurtPlayer('a', 'sealed'), false);
  assert.equal(w.canHurtPlayer('a', 'control'), true);
  const hs = s.hp, hc = c.hp;
  w.attack('a', 1, 0);
  assert.equal(s.hp, hs, 'sealed untouched');
  assert.ok(c.hp < hc, 'control hit by the same swing');
});

test('sealed owner keeps pet', () => {
  const w = new World(openMap(), new Map(), null);
  w.now = NOW;
  w.addPlayer('druid', { x: 500, y: 500 });
  w.creatures.addCreatures([{ id: 'pet', type: 'Wolf', x: 900, y: 500, hp: 40, level: 6, facing: 'S', color: '#c00' }]);
  w.creatures.charm('pet', { userId: 'druid', characterId: 3, expiresAt: NOW + 60000 });
  const druid = w.getPlayer('druid');
  seal(druid, w.now);
  const before = w.creatures.get('pet').x;
  w.creatures.tick(0.2, ACTIVE, [druid], w.now);
  const pet = w.creatures.get('pet');
  assert.ok(pet, 'pet still exists');
  assert.equal(pet.charmOwnerUserId, 'druid');
  assert.equal(pet.faction, 'charmed');
  assert.ok(pet.x < before, 'still follows its sealed druid');
});
