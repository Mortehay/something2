// backend/tests/boss_ai.test.js
// The boss controller (src/authority/bossAI.js): attack selection by distance and
// phase, anti-spam, telegraph floors, HP-threshold phases with invulnerability and
// adds -- and then the same controller driven through the REAL sim tick, so the
// telegraph / resolve wiring in creatures.js is covered, not only the pure part.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createBossController, profileFor, STATE, MIN_TELEGRAPH_MS, MIN_ULTIMATE_TELEGRAPH_MS, CLOSE_RANGE, MID_RANGE,
} = require('../src/authority/bossAI.js');
const { applyDamage } = require('../src/authority/damage.js');
const { CreatureSim } = require('../src/authority/creatures.js');

const END = { name: 'zzEnd', boss_tier: 'dungeon_end', element: 'fire', hitbox_size: 96 };
const ELITE = { name: 'zzElite', boss_tier: 'dungeon_elite', element: 'arcane', hitbox_size: 72 };

function boss(row = END, over = {}) {
  const c = { id: 'b', x: 0, y: 0, width: 96, height: 96, hp: 1000, maxHp: 1000, _skillCd: new Map(), _pendingSkill: null, ...over };
  return { c, ai: createBossController(row, { seed: 7 }) };
}
// One pick with a clear gap and no cooldowns.
function pickAt(ai, c, dist, now = 100000) {
  ai.nextAttackAt = 0;
  return ai.pick(c, dist, now);
}

// ---- the attack selector --------------------------------------------------

test('close range: the boss uses a melee-range AoE around itself, never a gap closer', () => {
  const { c, ai } = boss();
  const seen = new Set();
  for (let i = 0; i < 30; i += 1) { c._skillCd.clear(); ai.lastAttackId = null; seen.add(pickAt(ai, c, 100).name); }
  assert.deepEqual([...seen].sort(), ['flurry', 'quake']);
});

test('mid range: a ground slam on the target', () => {
  const { c, ai } = boss();
  const s = pickAt(ai, c, (CLOSE_RANGE + MID_RANGE) / 2);
  assert.equal(s.name, 'slam');
  assert.equal(s.kind, 'slam');
});

test('far away in phase 1: a ranged bolt (the gap closers are not unlocked yet)', () => {
  const { c, ai } = boss();
  const s = pickAt(ai, c, 600);
  assert.equal(s.name, 'bolt');
  assert.equal(s.kind, 'projectile');
});

test('far away from phase 2 on: charge or blink close the gap, as well as the bolt', () => {
  const { c, ai } = boss();
  ai.phase = 2;
  const seen = new Set();
  for (let i = 0; i < 80; i += 1) { c._skillCd.clear(); ai.lastAttackId = null; seen.add(pickAt(ai, c, 600).name); }
  assert.ok(seen.has('charge') && seen.has('blink') && seen.has('bolt'), [...seen].join());
});

test('a charge is never offered when the target is already close (it needs distance to run)', () => {
  const { c, ai } = boss();
  ai.phase = 2;
  for (let i = 0; i < 40; i += 1) { c._skillCd.clear(); ai.lastAttackId = null; assert.notEqual(pickAt(ai, c, 120).name, 'charge'); }
});

test('the same attack is not picked twice in a row while an alternative exists', () => {
  const { c, ai } = boss();
  let prev = null;
  for (let i = 0; i < 40; i += 1) {
    c._skillCd.clear();
    const s = pickAt(ai, c, 100);
    assert.notEqual(s.name, prev);
    prev = s.name;
  }
});

test('after an attack there is a recovery gap: no new pick until it has passed', () => {
  const { c, ai } = boss();
  const first = pickAt(ai, c, 100, 1000);
  assert.ok(first);
  c._skillCd.clear();
  assert.equal(ai.pick(c, 100, 1000 + first.telegraphMs - 1), null, 'still winding up / recovering');
  assert.ok(ai.pick(c, 100, 1000 + first.telegraphMs + ai.profile.gapMs + 1), 'free again afterwards');
});

test('an attack on cooldown is skipped; with nothing ready the boss picks nothing', () => {
  const { c, ai } = boss();
  for (const a of ai.attacks) c._skillCd.set(a.slot, 5);
  assert.equal(pickAt(ai, c, 100), null);
});

test('an out-of-range target gets no skill', () => {
  const { c, ai } = boss();
  assert.equal(pickAt(ai, c, 5000), null);
});

test('the ultimate unlocks in phase 3 and then owns the top of the tree', () => {
  const { c, ai } = boss();
  for (let i = 0; i < 20; i += 1) { c._skillCd.clear(); ai.lastAttackId = null; assert.notEqual(pickAt(ai, c, 100).name, 'cataclysm'); }
  ai.phase = 3;
  c._skillCd.clear();
  const s = pickAt(ai, c, 100);
  assert.equal(s.name, 'cataclysm');
  assert.equal(s.ultimate, true);
  assert.ok(s.radius >= 400, 'a screen-sized circle');
});

test('hazard rain: the first zone sits on the target, the rest are scattered inside the spread', () => {
  const { c, ai } = boss();
  ai.phase = 3;
  ai.attacks = ai.attacks.filter((a) => a.id === 'rain');
  ai._tree = ai._buildTree();
  const s = pickAt(ai, c, 300);
  assert.equal(s.kind, 'rain');
  assert.equal(s.zones.length, 5);
  assert.deepEqual(s.zones[0], { dx: 0, dy: 0 });
  for (const z of s.zones) assert.ok(Math.hypot(z.dx, z.dy) <= 380 + 1e-6);
});

test('telegraphs never get shorter than the fairness floor, even in the last phase', () => {
  const { c, ai } = boss();
  ai.phase = 4;
  for (let i = 0; i < 60; i += 1) {
    c._skillCd.clear(); ai.lastAttackId = null;
    const s = pickAt(ai, c, [100, 300, 600][i % 3]);
    if (!s) continue;
    assert.ok(s.telegraphMs >= (s.ultimate ? MIN_ULTIMATE_TELEGRAPH_MS : MIN_TELEGRAPH_MS), `${s.name} ${s.telegraphMs}`);
  }
});

test('later phases hit harder and recover faster', () => {  const only = (ai) => { ai.attacks = ai.attacks.filter((x) => x.id === 'slam'); ai._tree = ai._buildTree(); return ai; };  const a = boss(); const b = boss();  only(a.ai); only(b.ai);  b.ai.phase = 4;  const s1 = pickAt(a.ai, a.c, 300);  const s4 = pickAt(b.ai, b.c, 300);  assert.equal(s1.name, 'slam'); assert.equal(s4.name, 'slam');  assert.ok(s4.damageMult > s1.damageMult);  assert.ok(s4.cooldownMs < s1.cooldownMs);});

test('an elite is the lighter fight: fewer phases, no ultimate, no hazard rain', () => {
  const p = profileFor(ELITE);
  assert.equal(p.phases.length, 3);
  assert.equal(profileFor(END).phases.length, 4);
  assert.ok(!p.attacks.some((a) => a.ultimate || a.id === 'rain'));
});

// ---- phases ---------------------------------------------------------------

test('crossing a threshold starts a phase: invulnerable, still, pending wind-up cancelled, adds asked for', () => {
  const { c, ai } = boss();
  const events = [];
  ai.onEvent = (e) => events.push(e);
  c._pendingSkill = { skill: {}, resolveAt: 1 };
  assert.equal(ai.tick(c, { now: 1000 }), false, 'full hp: no transition');
  c.hp = 750;
  assert.equal(ai.tick(c, { now: 2000 }), true);
  assert.equal(ai.phase, 2);
  assert.equal(ai.state, STATE.TRANSITION);
  assert.equal(c._pendingSkill, null);
  assert.equal(c._invulnerableUntil, 2000 + 2000);
  const ev = events.find((e) => e.type === 'phase');
  assert.equal(ev.phase, 2);
  assert.equal(ev.adds, 2);
  assert.equal(ai.pick(c, 100, 2500), null, 'no attacks mid-transition');
  assert.equal(ai.tick(c, { now: 3999 }), true, 'still transitioning');
  assert.equal(ai.tick(c, { now: 4000 }), false, 'over');
  assert.equal(ai.state, STATE.ENGAGED);
  assert.equal(c._invulnerableUntil, 0);
  assert.ok(events.some((e) => e.type === 'phase_end'));
});

test('the arena changes in phase 3', () => {
  const { c, ai } = boss();
  const events = [];
  ai.onEvent = (e) => events.push(e);
  c.hp = 750; ai.tick(c, { now: 0 });
  c.hp = 500; ai.tick(c, { now: 2000 });
  c.hp = 500; ai.tick(c, { now: 4500 });
  const p3 = events.filter((e) => e.type === 'phase').find((e) => e.phase === 3);
  assert.equal(p3.arena, 'hazards');
});

test('damage cannot take the boss below the next threshold, so a burst cannot skip a phase', () => {
  const { c, ai } = boss();
  ai.tick(c, { now: 0 });                       // arms the first gate
  assert.equal(c._hpFloor, 750);
  applyDamage(c, 5000, 'physical', { defense: 0, resistances: {} }, 10, 'p:1');
  assert.equal(c.hp, 750, 'held at the 75% line, not dead');
  assert.equal(ai.tick(c, { now: 20 }), true);
  assert.equal(ai.phase, 2);
  assert.equal(c._hpFloor, 500, 'the next gate is armed');
});

test('while invulnerable the boss takes nothing: no hp, no attribution', () => {
  const { c, ai } = boss();
  ai.tick(c, { now: 0 });
  c.hp = 750; ai.tick(c, { now: 1000 });
  const before = c.hp;
  const dealt = applyDamage(c, 999, 'physical', { defense: 0, resistances: {} }, 1500, 'p:9');
  assert.equal(dealt, 0);
  assert.equal(c.hp, before);
  assert.equal(c._playerDamage, undefined, 'no damage credit for a blow that did nothing');
  applyDamage(c, 100, 'physical', { defense: 0, resistances: {} }, 3500, 'p:9');
  assert.ok(c.hp < before, 'vulnerable again once it ends');
});

test('thresholds are only crossed once each, in order, down to the last phase', () => {
  const { c, ai } = boss();
  const phases = [];
  ai.onEvent = (e) => { if (e.type === 'phase') phases.push(e.phase); };
  let now = 0;
  for (const hp of [900, 749, 600, 499, 300, 249, 100, 10]) {
    c.hp = hp; now += 5000; ai.tick(c, { now });
    now += 5000; ai.tick(c, { now });
  }
  assert.deepEqual(phases, [2, 3, 4]);
  assert.equal(c._hpFloor, null, 'no gate after the last phase');
});

// ---- through the real sim tick ----------------------------------------------

function openMap() { return { isWalkable: () => true, speedAt: () => 1, chunkSize: 8 }; }
const active = new Set(['0,0', '0,1', '1,0', '1,1']);

function bossRow() {
  return {
    id: 'B1', type: 'zzEnd', x: 500, y: 500, hp: 5000, facing: 'S', home_x: null, home_y: null,
    level: 1, damage: 20, blocks_portal_id: null, defense: 0, color: '#fff', resistances: {},
    faction: 'hostile', attack_element: 'physical', behavior_name: 'T', aggro_radius: 900, leash_radius: 1800,
    chase_style: 'hold', preferred_range: 0, move_speed_mult: 1, damage_override: null,
    aura_names: null, aura_defs: [], behavior_gold_min: 0, behavior_gold_max: 0, abilities: [], skills: [],
    boss_tier: 'dungeon_end', element: 'fire',
  };
}
function simWith(ai) {
  const s = new CreatureSim(openMap(), () => 0.5);
  s.addCreatures([bossRow()]);
  const b = s.get('B1');
  b.bossAI = ai;
  let now = 0;
  const step = (players, ms) => { now += ms; return s.tick(ms / 1000, active, players, now); };
  return { s, b, step, clock: () => now };
}
const player = (x, y, over = {}) => ({
  userId: 'u1', x, y, width: 64, height: 64, hp: 100000, maxHp: 100000, _buff: undefined, ...over,
});

test('sim: a boss with a player in its face winds up a telegraphed AoE, then hits when it lands', () => {
  const ai = createBossController(END, { seed: 3 });
  ai.attacks = ai.attacks.filter((a) => a.id === 'quake');
  ai._tree = ai._buildTree();
  const { b, step } = simWith(ai);
  const p = player(b.x + 20, b.y + 20);
  const hp0 = p.hp;
  const first = step([p], 50);
  assert.equal(first.telegraphs.length, 1, 'the wind-up is announced');
  assert.equal(first.telegraphs[0].skill, 'quake');
  assert.ok(first.telegraphs[0].radius > 0 && first.telegraphs[0].telegraphMs >= MIN_TELEGRAPH_MS);
  assert.equal(p.hp, hp0, 'nothing lands during the wind-up');
  let landed = false;
  for (let t = 0; t < first.telegraphs[0].telegraphMs + 200 && !landed; t += 50) { step([p], 50); landed = p.hp < hp0; }
  assert.ok(landed, 'the AoE resolves on the player after the telegraph');
});

test('sim: a charge is telegraphed as a LINE and runs the boss through it, hurting what is in the lane', () => {
  const ai = createBossController(END, { seed: 3 });
  ai.phase = 2;
  ai.attacks = ai.attacks.filter((a) => a.id === 'charge');
  ai._tree = ai._buildTree();
  const { b, step } = simWith(ai);
  const p = player(b.x + 500, b.y);          // 500px east: far, in the lane
  const hp0 = p.hp;
  const x0 = b.x;
  const first = step([p], 50);
  const tg = first.telegraphs[0];
  assert.equal(tg.skill, 'charge');
  assert.equal(tg.kind, 'line');
  assert.ok(tg.ex > tg.x, 'the lane points at the target');
  for (let t = 0; t < tg.telegraphMs + 300; t += 50) step([p], 50);
  assert.ok(b.x > x0 + 300, `the boss ran east (${x0} -> ${b.x})`);
  assert.ok(p.hp < hp0, 'the player in the lane was hit');
});

test('sim: hazard rain announces one telegraph per zone', () => {
  const ai = createBossController(END, { seed: 3 });
  ai.phase = 3;
  ai.attacks = ai.attacks.filter((a) => a.id === 'rain');
  ai._tree = ai._buildTree();
  const { b, step } = simWith(ai);
  const first = step([player(b.x + 300, b.y)], 50);
  assert.equal(first.telegraphs.length, 5);
  assert.ok(first.telegraphs.every((t) => t.skill === 'rain'));
});

test('sim: at a threshold the boss stops, is untouchable, and resumes afterwards', () => {
  const ai = createBossController(END, { seed: 3 });
  const events = [];
  ai.onEvent = (e) => events.push(e);
  const { s, b, step } = simWith(ai);
  const p = player(b.x + 20, b.y + 20);
  step([p], 50);                              // arms the gate, starts a first attack
  b.hp = 0.74 * b.maxHp;
  const r = step([p], 50);
  assert.ok(events.some((e) => e.type === 'phase' && e.phase === 2));
  assert.equal(r.telegraphs.length, 0, 'a transitioning boss starts nothing');
  const hp = b.hp;
  assert.equal(s.damageCreatureById('B1', 5000, 'physical', 100, 'p:u1'), false);
  assert.equal(b.hp, hp, 'untouchable');
  for (let t = 0; t < 2100; t += 50) step([p], 50);
  assert.equal(ai.state, STATE.ENGAGED);
  s.damageCreatureById('B1', 50, 'physical', 100000, 'p:u1');
  assert.ok(b.hp < hp, 'damageable again');
});

test('sim: a boss with no controller behaves exactly as before (no skills -> no telegraph)', () => {
  const s = new CreatureSim(openMap(), () => 0.5);
  s.addCreatures([bossRow()]);
  let now = 0;
  const r = s.tick(0.05, active, [player(520, 520)], (now += 50));
  assert.equal(r.telegraphs.length, 0);
});
