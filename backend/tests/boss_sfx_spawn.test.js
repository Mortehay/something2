// backend/tests/boss_sfx_spawn.test.js
// SOMET-605 (S2, spec §4.4): a boss entering a sim announces itself with one
// `spawn` sfx event -- from addCreatures, the one door every boss passes
// (world bosses now, S9's dungeon bosses later), so no spawn path can forget it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { CreatureSim } = require('../src/authority/creatures.js');

const sim = () => new CreatureSim({ isWalkable: () => true, speedAt: () => 1, chunkSize: 8 }, () => 0.05);
const boss = (over = {}) => ({ id: 'wb_1', type: 'zzTitan', x: 100, y: 200, hp: 5000, bossTier: 'world', hitboxSize: 96, ...over });

test('a boss-tier instance emits exactly one spawn event at its box centre', () => {
  const s = sim();
  s.addCreatures([boss()]);
  // x 100 + 96/2 = 148, y 200 + 96/2 = 248 (fixture numbers, not CREATURE_SIZE).
  assert.deepEqual(s.sfx, [{ e: 'spawn', c: 'zzTitan', a: 'c:wb_1', x: 148, y: 248 }]);
});

test('an ordinary creature emits nothing on add', () => {
  const s = sim();
  s.addCreatures([{ id: 'c1', type: 'Slime', x: 0, y: 0, hp: 10 }]);
  assert.deepEqual(s.sfx, []);
});

test('re-adding a known id emits nothing (addCreatures skips it)', () => {
  const s = sim();
  s.addCreatures([boss()]);
  s.sfx = [];
  s.addCreatures([boss()]);
  assert.deepEqual(s.sfx, []);
});

test('quietSpawn suppresses the event (lost-boss re-place)', () => {
  const s = sim();
  s.addCreatures([boss({ quietSpawn: true })]);
  assert.deepEqual(s.sfx, []);
  assert.ok(s.get('wb_1'), 'the boss is still added');
  assert.equal('quietSpawn' in s.get('wb_1'), false, 'quietSpawn is an input flag, never stored on the sim creature');
});
