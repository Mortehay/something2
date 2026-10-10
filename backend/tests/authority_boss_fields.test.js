// SOMET-603 (S1). addCreatures is the one door into the sim, and it used to
// whitelist fields: a boss arrived with isWorldBoss/bossElement/name and a 96
// box, and left with none of them at 48. Everything S1 adds (hitbox, art
// size, boss render, boss audio) depends on these surviving the door.
const test = require('node:test');
const assert = require('node:assert/strict');
const { CreatureSim } = require('../src/authority/creatures.js');

const stubMap = () => ({ isWalkable: () => true, speedAt: () => 1, chunkSize: 8 });
const rng = () => 0.05;

test('addCreatures keeps a boss instance\'s tier, element, name and hitbox', () => {
  const s = new CreatureSim(stubMap(), rng);
  s.addCreatures([{
    id: 'b1', type: 'zzBoss', name: 'zzBoss Display', x: 100, y: 100, hp: 5000,
    bossTier: 'world', element: 'ice', hitboxSize: 96,
  }]);
  const c = s.get('b1');
  assert.equal(c.bossTier, 'world');
  assert.equal(c.element, 'ice');
  assert.equal(c.name, 'zzBoss Display');
  assert.equal(c.hitboxSize, 96);
  assert.equal(c.width, 96);
  assert.equal(c.height, 96);
});

test('an ordinary creature keeps the 48px box and null boss fields', () => {
  const s = new CreatureSim(stubMap(), rng);
  s.addCreatures([{ id: 'w1', type: 'Wolf', x: 100, y: 100, hp: 10 }]);
  const c = s.get('w1');
  assert.equal(c.width, 48);
  assert.equal(c.height, 48);
  assert.equal(c.bossTier, null);
  assert.equal(c.element, null);
  assert.equal(c.hitboxSize, null);
  assert.equal(c.name, 'Wolf', 'name falls back to the type');
});

// Review Focus 1: a cleared or junk hitbox must degrade to the default box,
// never to NaN/0 (Canvas and resolveMove both silently misbehave on those).
for (const bad of [null, undefined, 0, -5, 12.5, '96', Number.NaN, 401]) {
  test(`hitboxSize ${String(bad)} falls back to the 48px box`, () => {
    const s = new CreatureSim(stubMap(), rng);
    s.addCreatures([{ id: 'x', type: 'zzBoss', x: 0, y: 0, hp: 1, bossTier: 'world', hitboxSize: bad }]);
    const c = s.get('x');
    assert.equal(c.width, 48);
    assert.equal(c.height, 48);
    assert.equal(c.hitboxSize, null);
  });
}
