// SOMET-603: the client cannot draw a boss it is never told is a boss. Today
// the snapshot carries no width, name or tier, so the client sizes every boss
// at 48 and centres it 24px off its server box.
const test = require('node:test');
const assert = require('node:assert/strict');
const { CreatureSim } = require('../src/authority/creatures.js');

const stubMap = () => ({ isWalkable: () => true, speedAt: () => 1, chunkSize: 8 });

test('a boss is introduced with its tier, element, name and size, then never again', () => {
  const s = new CreatureSim(stubMap(), () => 0.05);
  s.addCreatures([{ id: 'b', type: 'zzBoss', name: 'zzBoss', x: 100, y: 100, hp: 9000,
    bossTier: 'world', element: 'fire', hitboxSize: 96 }]);
  const known = new Set();
  const first = s.snapshotAOI(new Set(['0,0']), 0, 100, 100, 2400, known)[0];
  assert.equal(first.bossTier, 'world');
  assert.equal(first.element, 'fire');
  assert.equal(first.name, 'zzBoss');
  assert.equal(first.width, 96);
  assert.equal(first.height, 96);
  const second = s.snapshotAOI(new Set(['0,0']), 0, 100, 100, 2400, known)[0];
  for (const f of ['bossTier', 'element', 'name', 'width', 'height']) {
    assert.ok(!(f in second), `"${f}" is immutable and must not be re-sent every frame`);
  }
});

test('an ordinary creature\'s intro carries none of the boss fields', () => {
  const s = new CreatureSim(stubMap(), () => 0.05);
  s.addCreatures([{ id: 'w', type: 'Wolf', x: 100, y: 100, hp: 10, color: '#c0392b' }]);
  const first = s.snapshotAOI(new Set(['0,0']), 0, 100, 100, 2400, new Set())[0];
  for (const f of ['bossTier', 'element', 'name', 'width', 'height']) {
    assert.ok(!(f in first), `"${f}" must not cost bytes on every ordinary creature`);
  }
});
