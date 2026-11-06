// Sprint (hold Shift): server-authoritative, 1.5x, paid in stamina.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  World, SPRINT_MULT, SPRINT_DRAIN, SPRINT_START, SPRINT_UNLOCK, selfAuraFields,
} = require('../src/authority/world.js');
const { applyEffect, CHILL, applyStun } = require('../src/authority/effects.js');

const flat = (speed = 1) => ({ isWalkable: () => true, speedAt: () => speed, width: 4000, height: 4000, decorations: [] });
function stats() {
  return {
    meleeMult: 1, spellMult: 1, level: 10, strength: 10, dexterity: 10, constitution: 10, intelligence: 10, wisdom: 10, charisma: 10,
    damageMult: {}, resists: {}, rules: {}, sources: {},
  };
}
function mk(map = flat()) {
  const w = new World(map, new Map(), 'fists');
  w.addPlayer('u1', { x: 200, y: 200 }, { items: [], equipment: {} }, { x: 200, y: 200 }, 0, stats());
  const p = w.getPlayer('u1');
  p.hp = 1000; p.maxHp = 1000; p.stamina = 100; p.maxStamina = 100; p.stats.staminaRegen = 10;
  return { w, p };
}
// Runs `seconds` of input in 50 ms steps, heading east; returns the distance covered.
function run(w, p, seconds, sprint, seq0 = 1) {
  const x0 = p.x;
  for (let i = 0; i < Math.round(seconds / 0.05); i += 1) {
    w.setInput('u1', seq0 + i, 1, 0, 0.05, sprint);
    w.tick(0.05);
  }
  return p.x - x0;
}

test('sprinting moves 1.5x as far as walking in the same time', () => {
  const a = mk(); const b = mk();
  const walk = run(a.w, a.p, 1, false);
  const sprint = run(b.w, b.p, 1, true);
  assert.ok(Math.abs(sprint / walk - SPRINT_MULT) < 0.02, `ratio ${sprint / walk}`);
});

test('it costs stamina per second moved, and stamina does not regenerate meanwhile', () => {
  const { w, p } = mk();
  run(w, p, 1, true);
  assert.ok(Math.abs(p.stamina - (100 - SPRINT_DRAIN)) < 1, `stamina ${p.stamina}`);
});

test('walking regenerates stamina again; sprinting does not', () => {
  const { w, p } = mk();
  p.stamina = 50;
  run(w, p, 1, false);
  assert.ok(p.stamina > 55, `walking regenerated: ${p.stamina}`);
  const before = p.stamina;
  run(w, p, 1, true, 100);
  assert.ok(p.stamina < before, 'sprinting only spends');
});

test('it will not start below the start threshold', () => {
  const { w, p } = mk();
  p.stamina = SPRINT_START - 1; p.stats.staminaRegen = 0; // no regen, or it climbs past the threshold mid-test
  const d = run(w, p, 0.5, true);
  const ref = mk(); ref.p.stamina = 100;
  const walk = run(ref.w, ref.p, 0.5, false);
  assert.ok(Math.abs(d / walk - 1) < 0.05, 'walked');
});

test('running dry locks sprint until the unlock threshold, then it works again', () => {
  const { w, p } = mk();
  p.stamina = 12; p.stats.staminaRegen = 0;
  run(w, p, 3, true);
  assert.equal(p.stamina < SPRINT_START, true, 'ran dry');
  assert.equal(p._sprintLock, true);
  assert.equal(selfAuraFields(p, w.now).sprintLock, 1, 'the owner is told');
  // Walking regenerates; sprint stays off until stamina >= SPRINT_UNLOCK.
  p.stamina = SPRINT_UNLOCK - 1;
  const locked = run(w, p, 0.2, true, 200);
  const ref = mk(); const walk = run(ref.w, ref.p, 0.2, false);
  assert.ok(Math.abs(locked / walk - 1) < 0.1, 'still walking at 19');
  p.stamina = SPRINT_UNLOCK + 1;
  const fast = run(w, p, 0.2, true, 300);
  assert.ok(fast / walk > 1.35, 'sprinting again at 21');
});

test('standing still while holding Shift costs nothing', () => {
  const { w, p } = mk();
  for (let i = 0; i < 20; i += 1) { w.setInput('u1', i + 1, 0, 0, 0.05, true); w.tick(0.05); }
  assert.equal(p.stamina, 100);
});

test('it composes with chill and with tile speed instead of replacing them', () => {
  const road = mk(flat(1.2));
  const plain = mk(flat(1));
  const roadSprint = run(road.w, road.p, 1, true);
  const plainWalk = run(plain.w, plain.p, 1, false);
  assert.ok(Math.abs(roadSprint / plainWalk - 1.2 * SPRINT_MULT) < 0.03, `road x sprint ${roadSprint / plainWalk}`);

  const chilled = mk();
  applyEffect(chilled.p, CHILL, { durationMs: 60000, magnitude: 0.5, now: chilled.w.now });
  const slowSprint = run(chilled.w, chilled.p, 1, true);
  const free = mk(); const freeWalk = run(free.w, free.p, 1, false);
  assert.ok(Math.abs(slowSprint / freeWalk - 0.5 * SPRINT_MULT) < 0.05, `chill x sprint ${slowSprint / freeWalk}`);
});

test('blocked while stunned, rooted or channelling a skill', () => {
  const walkRef = (() => { const r = mk(); return run(r.w, r.p, 0.5, false); })();
  {
    const { w, p } = mk();
    applyStun(p, 5000, w.now);
    assert.equal(run(w, p, 0.5, true), 0, 'a stunned player does not move at all');
    assert.equal(p.stamina, 100, 'and pays nothing');
  }
  {
    const { w, p } = mk();
    applyEffect(p, CHILL, { durationMs: 60000, magnitude: 0.001, now: w.now }); // a root
    run(w, p, 0.5, true);
    assert.equal(p.stamina, 100, 'a rooted sprint costs nothing');
  }
  {
    const { w, p } = mk();
    p._channelSkillId = 'war_whirlwind';
    p._lastChannelAt = w.now;
    const d = run(w, p, 0.5, true);
    assert.ok(Math.abs(d / walkRef - 1) < 0.1, 'channelling: walked');
    assert.equal(p.stamina >= 100 - 0.001, true);
  }
});

test('a forged client cannot exceed 1.5x: sprint on every frame, a huge dt, many inputs', () => {
  const { w, p } = mk();
  const x0 = p.x;
  // One tick of server time, 200 forged inputs claiming a full second each.
  for (let i = 0; i < 200; i += 1) w.setInput('u1', i + 1, 1, 0, 1.0, true);
  w.tick(0.05);
  const legal = 200 * SPRINT_MULT * (1.1 * 0.05 + 0.5); // PLAYER_SPEED * sprint * (credit rate*dt + banked cap)
  assert.ok(p.x - x0 <= legal + 1, `moved ${p.x - x0}, legal ${legal}`);
  assert.ok(p.x - x0 < 200 * 2, 'nowhere near unbounded');
});

test('the sprint flag is a strict boolean: a string from the wire is not a sprint', () => {
  const a = mk(); const b = mk();
  const x0 = b.p.x;
  for (let i = 0; i < 20; i += 1) { b.w.setInput('u1', i + 1, 1, 0, 0.05, 'true'); b.w.tick(0.05); }
  const forged = b.p.x - x0;
  const walk = run(a.w, a.p, 1, false);
  assert.ok(Math.abs(forged / walk - 1) < 0.02);
  assert.equal(b.p.stamina, 100);
});

test('the self frame says sprint only while it is happening', () => {
  const { w, p } = mk();
  assert.deepEqual(selfAuraFields(p, w.now), {});
  w.setInput('u1', 1, 1, 0, 0.05, true); w.tick(0.05);
  assert.equal(selfAuraFields(p, w.now).sprint, 1);
  w.setInput('u1', 2, 0, 0, 0.05, false); w.tick(0.05);
  assert.equal(selfAuraFields(p, w.now).sprint, undefined);
});

test('the player row says `sp` only while sprinting, so every client can draw the wind', () => {
  const { w, p } = mk();
  run(w, p, 0.5, true);
  assert.equal(w.snapshot().players.find((r) => r.id === 'u1').sp, 1, 'sprinting');
  run(w, p, 0.5, false, 1000);
  assert.equal(w.snapshot().players.find((r) => r.id === 'u1').sp, undefined, 'walking: key omitted');
});
