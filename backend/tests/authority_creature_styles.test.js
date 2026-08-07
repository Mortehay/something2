const test = require('node:test');
const assert = require('node:assert');
const { CreatureSim } = require('../src/authority/creatures.js');

function stubMap() { return { isWalkable: () => true, speedAt: () => 1, chunkSize: 8 }; }
const noRedirect = () => 0.05;

function behavior(over = {}) {
  return {
    name: 'T', attackKind: 'melee', attackRange: 60, attackCooldown: 1,
    projectileSpeed: 0, projectileRadius: 0, aggroRadius: 400, leashRadius: 800,
    chaseStyle: 'charge', preferredRange: 0, moveSpeedMult: 1, damageOverride: null,
    ...over,
  };
}

// Creature at (100,100); player placed relative to it on the x axis.
function scenario(bh, playerX) {
  const s = new CreatureSim(stubMap(), noRedirect);
  s.addCreatures([{ id: 'c', type: 'T', x: 100, y: 100, hp: 100, behavior: bh, damage: 5 }]);
  const player = { userId: 'u1', x: playerX, y: 100, width: 48, height: 48, hp: 500 };
  return { s, player, active: new Set(['0,0', '0,1', '1,0', '1,1']) };
}

test('kite RETREATS from a target inside preferred range', () => {
  const { s, player, active } = scenario(
    behavior({ chaseStyle: 'kite', attackKind: 'ranged', attackRange: 340, preferredRange: 240 }), 200);
  s.tick(0.1, active, [player], 0);
  // Player is to the EAST (x 200 > 100) and only 100px away, inside the 240
  // preferred range. The creature must move WEST -- away.
  assert.ok(s.all()[0].x < 100, `expected retreat west, got x=${s.all()[0].x}`);
});

test('kite APPROACHES a target beyond attack range', () => {
  const { s, player, active } = scenario(
    behavior({ chaseStyle: 'kite', attackKind: 'ranged', attackRange: 340, preferredRange: 240 }), 600);
  s.tick(0.1, active, [player], 0);
  assert.ok(s.all()[0].x > 100, `expected approach east, got x=${s.all()[0].x}`);
});

test('kite HOLDS between preferred range and attack range', () => {
  const { s, player, active } = scenario(
    behavior({ chaseStyle: 'kite', attackKind: 'ranged', attackRange: 340, preferredRange: 240 }), 380);
  s.tick(0.1, active, [player], 0);
  assert.equal(s.all()[0].x, 100, 'must not move inside the comfortable band');
});

test('hold never moves, even with a target in range', () => {
  const { s, player, active } = scenario(
    behavior({ chaseStyle: 'hold', attackKind: 'ranged', attackRange: 380 }), 300);
  const before = { ...s.all()[0] };
  for (let i = 0; i < 20; i++) s.tick(0.05, active, [player], i * 0.05);
  const after = s.all()[0];
  assert.equal(after.x, before.x);
  assert.equal(after.y, before.y);
});

test('hold does not roam when there is no target either', () => {
  const { s, active } = scenario(behavior({ chaseStyle: 'hold' }), 0);
  const before = { ...s.all()[0] };
  for (let i = 0; i < 20; i++) s.tick(0.05, active, [], i * 0.05);
  assert.equal(s.all()[0].x, before.x);
  assert.equal(s.all()[0].y, before.y);
});

test('ambush stays still until a target enters aggro radius, then closes', () => {
  const bh = behavior({ chaseStyle: 'ambush', aggroRadius: 180, moveSpeedMult: 1.6 });
  const { s, active } = scenario(bh, 0);
  const far = { userId: 'u1', x: 500, y: 100, width: 48, height: 48, hp: 500 };
  for (let i = 0; i < 10; i++) s.tick(0.05, active, [far], i * 0.05);
  assert.equal(s.all()[0].x, 100, 'must not roam while dormant');
  assert.equal(s.all()[0].mode, 'roam');

  const near = { userId: 'u1', x: 220, y: 100, width: 48, height: 48, hp: 500 };
  s.tick(0.05, active, [near], 1);
  assert.ok(s.all()[0].x > 100, 'must close once aggroed');
  assert.equal(s.all()[0].mode, 'chase');
});

test('skirmish retreats after it lands a hit, then closes again', () => {
  const bh = behavior({ chaseStyle: 'skirmish', attackRange: 60, preferredRange: 150, attackCooldown: 1 });
  const { s, active } = scenario(bh, 140);
  const player = { userId: 'u1', x: 140, y: 100, width: 48, height: 48, hp: 500, mit: null };
  // Close until it attacks: the hit is what flips it to retreat.
  let attacked = false;
  for (let i = 0; i < 40 && !attacked; i++) {
    s.tick(0.05, active, [player], i * 0.05);
    if (player.hp < 500) attacked = true;
  }
  assert.ok(attacked, 'skirmisher never landed a hit');
  const xAtHit = s.all()[0].x;
  s.tick(0.05, active, [player], 5);
  assert.ok(s.all()[0].x < xAtHit, 'must retreat immediately after striking');
});

test('an ambusher that never sees anyone still never moves', () => {
  const { s, active } = scenario(behavior({ chaseStyle: 'ambush', aggroRadius: 180 }), 0);
  for (let i = 0; i < 50; i++) s.tick(0.05, active, [], i * 0.05);
  assert.equal(s.all()[0].x, 100);
});
