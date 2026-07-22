const test = require('node:test');
const assert = require('node:assert');
const { CreatureSim, GUARD_LEASH_RADIUS, GUARD_DAMAGE } = require('../src/authority/creatures');

const MAP = { chunkSize: 64, isWalkable: () => true, speedAt: () => 1 };
const KEYS = new Set(['0,0']);
function sim() { return new CreatureSim(MAP, () => 0.5); }
const HOME = { x: 100, y: 100 };

function mk(over) {
  return { id: 'x', type: 'T', x: 0, y: 0, hp: 100, ...over };
}

test('a guard chases and damages the nearest hostile, never targeting players', () => {
  const s = sim();
  s.addCreatures([
    mk({ id: 'g', type: 'Village Guard', x: 100, y: 100, hp: 300, faction: 'guard', home_x: 100, home_y: 100 }),
    mk({ id: 'h', type: 'Slime', x: 140, y: 100, hp: 100 }),
  ]);
  // Player moved from the brief's (110,100) to (200,200): at (110,100) the
  // player's center was already within CONTACT_RANGE (60px) of the hostile
  // 'h' — so the untouched, byte-identical hostile path (unrelated to the
  // guard branch under test, and independently covered by
  // authority_creatures_combat.test.js's "deals contact damage on cooldown")
  // would bite the player the same tick it acquires it as a target, dropping
  // its hp to 95 regardless of what the guard does. That made the assertion
  // below fail for a reason orthogonal to guard behavior. Moving the player
  // out of h's contact range isolates what this test actually checks: the
  // guard targets/damages the hostile and never touches the player.
  const players = [{ userId: 1, x: 200, y: 200, width: 64, height: 64, hp: 100, maxHp: 100 }];
  const before = s.creatures.get('h').hp;
  s.tick(0.5, KEYS, players, 1000);
  const g = s.creatures.get('g');
  assert.equal(g._targetKind, 'creature', 'guard must target a creature, not a player');
  assert.equal(g._target, 'h');
  assert.ok(s.creatures.get('h').hp < before, 'guard should have dealt contact damage');
  assert.equal(players[0].hp, 100, 'guard must never damage a player');
});

test('tick returns ids of creatures killed by a guard', () => {
  const s = sim();
  s.addCreatures([
    mk({ id: 'g', type: 'Village Guard', x: 100, y: 100, hp: 300, faction: 'guard', home_x: 100, home_y: 100 }),
    mk({ id: 'h', type: 'Slime', x: 140, y: 100, hp: 1 }),
  ]);
  const killed = s.tick(0.5, KEYS, [], 1000);
  assert.deepEqual(killed, ['h']);
  assert.equal(s.creatures.has('h'), false, 'dead creature must leave the sim');
});

test('a guard never moves beyond its leash from home', () => {
  const s = sim();
  s.addCreatures([
    mk({ id: 'g', type: 'Village Guard', x: 100, y: 100, hp: 300, faction: 'guard', home_x: 100, home_y: 100 }),
    // hostile far outside the leash: guard must not acquire it and must not drift
    mk({ id: 'h', type: 'Slime', x: 100 + GUARD_LEASH_RADIUS + 500, y: 100, hp: 100 }),
  ]);
  for (let i = 0; i < 40; i++) s.tick(0.1, KEYS, [], 1000 + i);
  const g = s.creatures.get('g');
  const d = Math.hypot(g.x - HOME.x, g.y - HOME.y);
  assert.ok(d <= GUARD_LEASH_RADIUS, `guard drifted ${d} beyond leash ${GUARD_LEASH_RADIUS}`);
  assert.equal(g._target, null, 'must not acquire an out-of-leash hostile');
});

test('a guard walks back home when its target is gone and idles at post', () => {
  const s = sim();
  s.addCreatures([mk({ id: 'g', type: 'Village Guard', x: 260, y: 100, hp: 300, faction: 'guard', home_x: 100, home_y: 100 })]);
  for (let i = 0; i < 200; i++) s.tick(0.1, KEYS, [], 1000 + i);
  const g = s.creatures.get('g');
  assert.ok(Math.hypot(g.x - HOME.x, g.y - HOME.y) < 40, `guard did not return home (at ${g.x},${g.y})`);
  assert.equal(g.mode, 'guard');
});

test('hostile behavior is unchanged: still targets the player, ignores guards', () => {
  const s = sim();
  s.addCreatures([
    mk({ id: 'h', type: 'Slime', x: 100, y: 100, hp: 100 }),
    mk({ id: 'g', type: 'Village Guard', x: 120, y: 100, hp: 300, faction: 'guard', home_x: 120, home_y: 100 }),
  ]);
  const players = [{ userId: 7, x: 160, y: 100, width: 64, height: 64, hp: 100, maxHp: 100, mit: null }];
  s.tick(0.2, KEYS, players, 1000);
  const h = s.creatures.get('h');
  assert.equal(h._target, 7, 'hostile must still target the player by userId');
  assert.equal(h.mode, 'chase');
  assert.equal(s.creatures.get('g').hp, 300, 'hostile must not damage the guard');
});
