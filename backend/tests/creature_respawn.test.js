const test = require('node:test');
const assert = require('node:assert');
const {
  isClearOfPlayers, RESPAWN_DELAY_MS, CREATURE_SWEEP_MS, RESPAWN_MIN_PLAYER_DISTANCE,
} = require('../src/services/creatureRespawn');

test('an empty world is clear everywhere', () => {
  assert.equal(isClearOfPlayers(0, 0, []), true);
});

test('a position exactly at the minimum distance is clear', () => {
  // 1000 world px = 10 tiles at MAP_TILE_SIZE 100. Hand-typed, NOT derived
  // from RESPAWN_MIN_PLAYER_DISTANCE -- a test that reads the constant it is
  // testing passes for any value of that constant.
  assert.equal(isClearOfPlayers(1000, 0, [{ x: 0, y: 0 }]), true);
});

test('a position inside the minimum distance is not clear', () => {
  assert.equal(isClearOfPlayers(999, 0, [{ x: 0, y: 0 }]), false);
});

test('distance is measured diagonally, not per-axis', () => {
  // (700,700) is 700 away on each axis but 989.9 away in a straight line,
  // which is inside 1000. A per-axis check would wrongly call this clear.
  assert.equal(isClearOfPlayers(700, 700, [{ x: 0, y: 0 }]), false);
});

test('one nearby player is enough to reject, however many are far away', () => {
  const players = [{ x: 9000, y: 9000 }, { x: 50, y: 50 }, { x: -9000, y: 0 }];
  assert.equal(isClearOfPlayers(0, 0, players), false);
});

test('the shipped constants are the values the design settled on', () => {
  assert.equal(RESPAWN_DELAY_MS, 30000);
  assert.equal(CREATURE_SWEEP_MS, 10000);
  assert.equal(RESPAWN_MIN_PLAYER_DISTANCE, 1000);
});
