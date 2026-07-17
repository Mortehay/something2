const test = require('node:test');
const assert = require('node:assert');
const { World, PLAYER_MAX_HP, MELEE_RANGE, PLAYER_DAMAGE, PLAYER_ATTACK_COOLDOWN } = require('../src/authority/world.js');

function stubMap() { return { isWalkable: () => true, speedAt: () => 1, chunkSize: 8 }; }

test('addPlayer starts at full hp; snapshot exposes hp/maxHp', () => {
  const w = new World(stubMap());
  w.addPlayer('u1', { x: 100, y: 100 });
  const p = w.getPlayer('u1');
  assert.equal(p.hp, PLAYER_MAX_HP);
  assert.equal(p.maxHp, PLAYER_MAX_HP);
  const snap = w.snapshot();
  assert.equal(snap.players[0].hp, PLAYER_MAX_HP);
  assert.equal(snap.players[0].maxHp, PLAYER_MAX_HP);
});

test('a player at <=0 hp respawns at spawn with full hp', () => {
  const w = new World(stubMap());
  w.addPlayer('u1', { x: 500, y: 500 });
  const p = w.getPlayer('u1');
  p.x = 900; p.y = 900; p.hp = -3; // simulate lethal damage away from spawn
  w.tickCreatures(0.05, new Set()); // no active chunks → creatures idle, but death resolves
  assert.equal(p.hp, PLAYER_MAX_HP);
  assert.equal(p.x, 500);
  assert.equal(p.y, 500);
});

test('attack is cooldown-gated and kills an adjacent creature', () => {
  const w = new World(stubMap());
  w.addPlayer('u1', { x: 100, y: 100 });
  // Load a low-hp creature right next to the player.
  w.creatures.addCreatures([{ id: 'x', type: 'Wolf', x: 110, y: 100, hp: 5, facing: 'S', color: '#c00' }]);
  const killed = w.attack('u1');
  assert.deepEqual(killed, ['x']);
  // Immediate re-attack is on cooldown → no-op.
  w.creatures.addCreatures([{ id: 'y', type: 'Wolf', x: 110, y: 100, hp: 5, facing: 'S', color: '#c00' }]);
  assert.deepEqual(w.attack('u1'), []);
});

test('attack from an unknown player returns []', () => {
  const w = new World(stubMap());
  assert.deepEqual(w.attack('nobody'), []);
});
