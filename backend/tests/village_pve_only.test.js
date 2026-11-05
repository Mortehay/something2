// SOMET-737: villages are PvE-only. Each test drives the real World paths and
// has a twin showing the same action DOES land outside a village, so none of
// them can pass just because the attack missed.
const test = require('node:test');
const assert = require('node:assert');
const { World } = require('../src/authority/world.js');
const { BURN, CHILL, applyEffect, applyCharm, charmerOf } = require('../src/authority/effects.js');

const openMap = () => ({ isWalkable: () => true, speedAt: () => 1, chunkSize: 1024 });

// Tiles 10..19 on both axes, so world pixels 1000..1999.
const VILLAGE = { id: 'v1', minRow: 10, minCol: 10, width: 10, height: 10 };
const INSIDE = 1500;
const OUTSIDE = 5000;

const melee = {
  id: 1, name: 'blade', category: 'weapon', kind: 'melee', damage: 20, cooldown: 0.1, reach: 200,
  arc_width: 3, mana_cost: 0, stamina_cost: 0, element: null, resistances: {},
};
const bow = {
  id: 2, name: 'bow', category: 'weapon', kind: 'projectile', damage: 20, cooldown: 0.1, range: 800,
  projectile_speed: 900, projectile_radius: 8, pierce: 1, mana_cost: 0, stamina_cost: 0,
  element: null, resistances: {},
};
const bomb = { ...bow, id: 3, name: 'bomb', aoe_radius: 150, detonate_at: 'contact' };

function worldWith(weapon) {
  const w = new World(openMap(), new Map([[weapon.id, weapon]]), weapon.id);
  w.villages = [VILLAGE];
  return w;
}

function duel(weapon, attackerX, targetX) {
  const w = worldWith(weapon);
  w.addPlayer('a', { x: attackerX, y: INSIDE });
  w.addPlayer('b', { x: targetX, y: INSIDE });
  const a = w.getPlayer('a');
  const b = w.getPlayer('b');
  b.y = a.y;
  return { w, a, b };
}

const flyProjectiles = (w) => { for (let i = 0; i < 40; i++) w.tickProjectiles(0.05); };

// Attacker, target x positions and whether the hit should land.
const PLACES = [
  ['both outside', OUTSIDE, OUTSIDE + 100, true],
  ['both inside', INSIDE, INSIDE + 100, false],
  // Either side of the east wall: pixel 2000 is the first tile outside.
  ['attacker outside, target inside', 2050, 1950, false],
  ['attacker inside, target outside', 1950, 2050, false],
];

for (const [where, ax, bx, lands] of PLACES) {
  test(`a swing, ${where}: ${lands ? 'lands' : 'does nothing'}`, () => {
    const { w, a, b } = duel(melee, ax, bx);
    const before = b.hp;
    const dir = Math.sign(bx - ax);
    const result = w.attack('a', dir, 0);
    assert.strictEqual(b.hp < before, lands, `hp ${before} -> ${b.hp}`);
    if (!lands) assert.deepEqual(result.impacts.filter((i) => i.t === 'p:b'), []);
    assert.ok(a.hp > 0);
  });

  test(`a shot, ${where}: ${lands ? 'lands' : 'does nothing'}`, () => {
    const { w, b } = duel(bow, ax, bx);
    const before = b.hp;
    w.attack('a', Math.sign(bx - ax), 0);
    assert.equal(w.projectiles.projectiles.length, 1, 'the shot was actually fired');
    flyProjectiles(w);
    assert.strictEqual(b.hp < before, lands, `hp ${before} -> ${b.hp}`);
  });

  test(`a blast, ${where}: ${lands ? 'lands' : 'does nothing'}`, () => {
    const { w, b } = duel(bomb, ax, bx);
    const before = b.hp;
    w.attack('a', Math.sign(bx - ax), 0);
    flyProjectiles(w);
    assert.strictEqual(b.hp < before, lands, `hp ${before} -> ${b.hp}`);
  });
}

test('a shot fired from inside stays harmless after the shooter walks out', () => {
  const { w, a, b } = duel(bow, 1950, 2300);
  w.attack('a', 1, 0);
  a.x = OUTSIDE;
  const before = b.hp;
  flyProjectiles(w);
  assert.equal(b.hp, before);
});

test('a blast set off by a creature-side contact spares the player but not the creature', () => {
  const { w, b } = duel(bomb, INSIDE, INSIDE + 300);
  w.creatures.creatures.set('c1', {
    id: 'c1', type: 'slime', x: INSIDE + 200, y: b.y, width: 48, height: 48, hp: 500, maxHp: 500, faction: 'hostile',
  });
  const hpBefore = b.hp;
  w.attack('a', 1, 0);
  flyProjectiles(w);
  assert.equal(b.hp, hpBefore, 'the player beside the blast is spared');
  assert.ok(w.creatures.creatures.get('c1').hp < 500, 'PvE still works inside the village');
});

test('a creature\'s shot still hurts a player in a village', () => {
  const w = worldWith(bow);
  w.addPlayer('b', { x: INSIDE, y: INSIDE });
  const b = w.getPlayer('b');
  const before = b.hp;
  w.projectiles.spawn({
    ownerId: 'c1', ownerKind: 'creature', ownerFaction: 'hostile', x: b.x - 100, y: b.y + b.height / 2,
    nx: 1, ny: 0, weapon: bow, damage: 20,
  });
  flyProjectiles(w);
  assert.ok(b.hp < before, `hp ${before} -> ${b.hp}`);
});

test('another player\'s burn ends inside a village and goes on outside it', () => {
  for (const [x, ends] of [[INSIDE, true], [OUTSIDE, false]]) {
    const { w, b } = duel(melee, OUTSIDE + 500, x);
    applyEffect(b, BURN, { durationMs: 4000, magnitude: 2, sourceId: 'a', now: w.now });
    const before = b.hp;
    for (let i = 0; i < 30; i++) w.tick(0.05);
    assert.strictEqual(b.hp === before, ends, `at x=${x}: hp ${before} -> ${b.hp}`);
    assert.strictEqual(b.effects.has(BURN), !ends);
  }
});

test('a creature\'s burn and a player\'s own effect keep running in a village', () => {
  const { w, b } = duel(melee, OUTSIDE, INSIDE);
  applyEffect(b, BURN, { durationMs: 4000, magnitude: 2, sourceId: 'creature-uuid', now: w.now });
  applyEffect(b, CHILL, { durationMs: 4000, magnitude: 0.25, sourceId: 'b', now: w.now });
  const before = b.hp;
  for (let i = 0; i < 30; i++) w.tick(0.05);
  assert.ok(b.hp < before, 'the creature burn still ticks');
  assert.ok(b.effects.has(CHILL), 'the self-applied effect stays');
});

test('walking into a village lifts another player\'s chill and pacify', () => {
  const { w, b } = duel(melee, OUTSIDE + 100, OUTSIDE);
  applyEffect(b, CHILL, { durationMs: 4000, magnitude: 0.25, sourceId: 'a', now: w.now });
  applyCharm(b, 'a', w.now);
  w.tick(0.05);
  assert.ok(b.speed < b.baseSpeed, 'sanity: chilled outside');
  assert.equal(charmerOf(b, w.now), 'a', 'sanity: pacified outside');
  b.x = INSIDE;
  w.tick(0.05);
  assert.equal(b.speed, b.baseSpeed);
  assert.equal(charmerOf(b, w.now), null);
});

test('a reflect does not reach a player standing in a village', () => {
  for (const [x, lands] of [[INSIDE, false], [OUTSIDE + 100, true]]) {
    const { w, a, b } = duel(melee, OUTSIDE, x);
    a._pendingReflect = [{ source: 'p:b', amount: 30 }];
    const before = b.hp;
    for (let i = 0; i < 2; i++) w.tick(0.05);
    assert.strictEqual(b.hp < before, lands, `at x=${x}: hp ${before} -> ${b.hp}`);
  }
});

test('the skill house next to a village is part of the zone', () => {
  const { villageSkillHouse } = require('../src/services/mapService.js');
  const house = villageSkillHouse(VILLAGE);
  const w = worldWith(melee);
  w.addPlayer('a', { x: 0, y: 0 });
  const a = w.getPlayer('a');
  a.x = (house.minCol * 100) + 50 - a.width / 2;
  a.y = (house.minRow * 100) + 50 - a.height / 2;
  assert.equal(w.inVillage(a), true);
});

test('a world with no villages has no zone', () => {
  const w = new World(openMap(), new Map([[1, melee]]), 1);
  w.addPlayer('a', { x: INSIDE, y: INSIDE });
  w.addPlayer('b', { x: INSIDE + 100, y: INSIDE });
  assert.equal(w.pvpBlocked(w.getPlayer('a'), w.getPlayer('b')), false);
});
