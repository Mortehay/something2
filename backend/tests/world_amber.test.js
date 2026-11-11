// Amber Stance wired into the World: join and respawn seal, a sealed player
// cannot move / attack / cast, the seal expires on tick, ready/break frames.
// Pure in-memory: a World with a stub map, no DB.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { World } = require('../src/authority/world.js');
const { setAmberConfig } = require('../src/authority/amber.js');

const stubMap = () => ({ chunkSize: 8, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] });
const DAGGER = { id: 1, name: 'dagger', category: 'weapon', kind: 'melee', damage: 8, cooldown: 0.3, reach: 80, arc_width: 0.6, mana_cost: 0, element: null };

function sealedWorld() {
  setAmberConfig({ maxMs: 30000, afterReadyMs: 10000, variants: [] });
  const w = new World(stubMap(), new Map([[1, DAGGER]]), 1);
  w.sealOnArrival = true;
  w.now = 5000;
  w.addPlayer('u1', { x: 400, y: 400 });
  return { w, p: w.getPlayer('u1') };
}

// Moves the clock past the seal's end and lets one tick expire it.
function expireSeal(w, p) {
  w.now = p.amber.endAt;
  w.tick(0.05);
}

test('join seals: the snapshot carries the full 30 s', () => {
  const { w, p } = sealedWorld();
  const snap = w.snapshot().players[0];
  assert.deepEqual(snap.amber, { a: p.amber.arrival, ms: 30000, v: null });
});

test('respawn seals at the moment of death', () => {
  const { w, p } = sealedWorld();
  expireSeal(w, p);
  assert.equal(p.amber, null);
  w.now = 90000;
  p.hp = 0;
  assert.deepEqual(w.resolveDeaths(), ['u1']);
  assert.ok(p.amber, 'respawn sealed the player');
  assert.equal(p.amber.startedAt, 90000);
});

test('a Blood Rebirth revive is not a death and does not seal', () => {
  const { w, p } = sealedWorld();
  expireSeal(w, p);
  p.buffs = p.buffs || new Map();
  // takeRevive reads this; the skillBalance contract is "revive fraction > 0".
  const skillBalance = require('../src/authority/skillBalance.js');
  const orig = skillBalance.takeRevive;
  skillBalance.takeRevive = () => 0.5;
  try {
    p.hp = 0;
    assert.deepEqual(w.resolveDeaths(), []);
    assert.equal(p.amber, null);
  } finally {
    skillBalance.takeRevive = orig;
  }
});

test('sealed player does not move; once expired the same input moves them', () => {
  const { w, p } = sealedWorld();
  const x0 = p.x;
  w.setInput('u1', 1, 1, 0, 0.05);
  w.setInput('u1', 2, 1, 0, 0.05);
  w.tick(0.05);
  assert.equal(p.x, x0, 'sealed player stayed put');
  expireSeal(w, p);
  w.setInput('u1', 3, 1, 0, 0.05);
  w.tick(0.05);
  assert.ok(p.x > x0, 'unsealed player moves');
});

test('an input queued before the seal does not move a freshly sealed player', () => {
  const { w, p } = sealedWorld();
  expireSeal(w, p);
  w.setInput('u1', 1, 1, 0, 0.05); // queued while free
  p.hp = 0;
  w.resolveDeaths(); // respawn seals; the queued input is still pending
  const x0 = p.x;
  w.tick(0.05);
  assert.equal(p.x, x0);
});

test('sealed player cannot attack or cast; the refusal says amber', () => {
  const { w, p } = sealedWorld();
  const gate = w.canAttack('u1');
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, 'amber');
  const r = w.attack('u1', 1, 0);
  assert.deepEqual(r.attacks, []);
  assert.equal(p._attackCd > 0, false, 'a refused swing stamps no cooldown');
  assert.equal(w.projectiles.projectiles.length, 0, 'no projectile spawned');
  const cast = w.castSkill('u1', 'mag_fireball', 500, 400, 1, 0);
  assert.equal(cast.ok, false);
  assert.equal(cast.reason, 'amber');

  // Control: the same swing lands once the seal is gone.
  expireSeal(w, p);
  assert.equal(w.canAttack('u1').ok, true);
  assert.ok(w.attack('u1', 1, 0).attacks.length > 0);
  assert.notEqual(w.castSkill('u1', 'mag_fireball', 500, 400, 1, 0).reason, 'amber');
});

test('expires on tick: the snapshot drops the key and the player can move', () => {
  const { w, p } = sealedWorld();
  expireSeal(w, p);
  assert.equal('amber' in w.snapshot().players[0], false);
  const x0 = p.x;
  w.setInput('u1', 1, 1, 0, 0.05);
  w.tick(0.05);
  assert.ok(p.x > x0);
});

test('ready then break ends the seal in the same call', () => {
  const { w, p } = sealedWorld();
  const a = p.amber.arrival;
  assert.equal(w.amberReady('u1', a), true);
  assert.equal(p.amber.readyAt, 5000);
  assert.equal(w.snapshot().players[0].amber.ms, 10000);
  assert.equal(w.amberBreak('u1', a), true);
  assert.equal(p.amber, null);
  assert.equal(w.canAttack('u1').ok, true);
});

test('break before ready ends the seal', () => {
  const { w, p } = sealedWorld();
  assert.equal(w.amberBreak('u1', p.amber.arrival), true);
  assert.equal(p.amber, null);
  assert.equal(w.canAttack('u1').ok, true);
});

test('a ready for an old arrival after a rejoin is ignored', () => {
  const { w, p } = sealedWorld();
  const oldArrival = p.amber.arrival;
  w.removePlayer('u1');
  w.addPlayer('u1', { x: 400, y: 400 });
  const p2 = w.getPlayer('u1');
  assert.notEqual(p2.amber.arrival, oldArrival);
  assert.equal(w.amberReady('u1', oldArrival), false);
  assert.equal(p2.amber.readyAt, null);
  assert.equal(w.amberBreak('u1', oldArrival), false);
  assert.ok(p2.amber);
});

test('ready/break for an unknown player are no-ops', () => {
  const { w } = sealedWorld();
  assert.equal(w.amberReady('nobody', 1), false);
  assert.equal(w.amberBreak('nobody', 1), false);
});

test('a World with sealOnArrival off never seals (the default)', () => {
  const w = new World(stubMap(), new Map([[1, DAGGER]]), 1);
  assert.equal(w.sealOnArrival, false);
  w.addPlayer('u1', { x: 400, y: 400 });
  const p = w.getPlayer('u1');
  assert.equal(p.amber, undefined);
  p.hp = 0;
  w.resolveDeaths();
  assert.equal(p.amber, undefined);
  assert.equal(w.canAttack('u1').ok, true);
});

test('snapshot omits amber when not sealed', () => {
  const { w, p } = sealedWorld();
  p.amber = null;
  assert.equal('amber' in w.snapshot().players[0], false);
});
