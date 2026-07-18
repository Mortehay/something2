const test = require('node:test');
const assert = require('node:assert');
const { World, PLAYER_SPEED } = require('../src/authority/world.js');

// Stub map: walkable unless x >= wall; speed 1.
function stubMap(wall = Infinity) {
  return { isWalkable: (wx) => wx < wall, speedAt: () => 1 };
}

test('setInput clamps dx,dy into [-1,1]', () => {
  const w = new World(stubMap());
  w.addPlayer('u1', { x: 0, y: 0 });
  w.setInput('u1', 1, 5, -9);
  w.tick(1); // speed*1*1 = PLAYER_SPEED on x, -PLAYER_SPEED on y (after normalize)
  const p = w.getPlayer('u1');
  // Clamped to (1,-1) then normalized by hypot(1,1): step = PLAYER_SPEED/sqrt2
  assert.ok(Math.abs(p.x - PLAYER_SPEED / Math.SQRT2) < 1e-3);
  assert.ok(Math.abs(p.y + PLAYER_SPEED / Math.SQRT2) < 1e-3);
});

test('tick advances a player on open ground', () => {
  const w = new World(stubMap());
  w.addPlayer('u1', { x: 0, y: 0 });
  w.setInput('u1', 1, 1, 0);
  w.tick(0.05);
  assert.ok(w.getPlayer('u1').x > 0);
});

test('tick blocks movement into an unwalkable tile', () => {
  const w = new World(stubMap(50)); // wall at x=50
  w.addPlayer('u1', { x: 0, y: 0 }); // center at (32,32); +x step would cross wall quickly
  w.setInput('u1', 1, 1, 0);
  w.tick(1); // large dt: step is huge, center+step >= 50 → blocked
  assert.equal(w.getPlayer('u1').x, 0);
});

test('ackSeq tracks the latest input seq; snapshot has the right shape', () => {
  const w = new World(stubMap());
  w.addPlayer('u1', { x: 3, y: 4 });
  w.setInput('u1', 7, 0, 0);
  w.tick(0.05);
  assert.equal(w.getPlayer('u1').ackSeq, 7);
  const snap = w.snapshot();
  assert.equal(snap.players.length, 1);
  // Widened in Task 5 (weapon dispatch/mana/projectiles): snapshot now also
  // carries mana/maxMana/equipment per player (mirrors the hp/maxHp precedent).
  // Task 6: weaponId retired in favor of equipment (inventory-driven weapon).
  assert.deepEqual(
    Object.keys(snap.players[0]).sort(),
    ['equipment', 'facing', 'hp', 'id', 'mana', 'maxHp', 'maxMana', 'x', 'y'],
  );
  assert.equal(snap.players[0].id, 'u1');
});

test('removePlayer + isEmpty', () => {
  const w = new World(stubMap());
  w.addPlayer('u1', { x: 0, y: 0 });
  assert.equal(w.isEmpty(), false);
  w.removePlayer('u1');
  assert.equal(w.isEmpty(), true);
});
