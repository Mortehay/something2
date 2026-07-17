const test = require('node:test');
const assert = require('node:assert');
const {
  CreatureSim, AGGRO_RADIUS, LEASH_RADIUS, CONTACT_RANGE,
  CREATURE_DAMAGE, CREATURE_ATTACK_COOLDOWN,
} = require('../src/authority/creatures.js');

function stubMap() { return { isWalkable: () => true, speedAt: () => 1, chunkSize: 8 }; }
const rng = () => 0.5; // no redirect, deterministic roam dir
function player(userId, x, y) { return { userId, x, y, width: 64, height: 64, hp: 100, maxHp: 100 }; }
function creatureAt(id, x, y, hp = 10) { return { id, type: 'Wolf', x, y, hp, facing: 'S', color: '#c00' }; }

test('a creature acquires and chases the nearest in-aggro player', () => {
  const s = new CreatureSim(stubMap(), rng);
  s.addCreatures([creatureAt('a', 100, 100)]);
  const p = player('u1', 100 + AGGRO_RADIUS - 50, 100); // east, within aggro
  s.tick(0.2, new Set(['0,0']), [p]);
  const c = s.all()[0];
  assert.equal(c.mode, 'chase');
  assert.equal(c._target, 'u1');
  assert.ok(c.x > 100, 'moved east toward the player');
});

test('a creature drops its target beyond the leash radius (back to roam)', () => {
  const s = new CreatureSim(stubMap(), rng);
  s.addCreatures([creatureAt('a', 100, 100)]);
  const p = player('u1', 200, 100);
  s.tick(0.1, new Set(['0,0']), [p]); // acquire
  assert.equal(s.all()[0].mode, 'chase');
  p.x = 100 + LEASH_RADIUS + 100; // run far away
  s.tick(0.1, new Set(['0,0']), [p]);
  assert.equal(s.all()[0].mode, 'roam');
  assert.equal(s.all()[0]._target, null);
});

test('a chasing creature deals contact damage on cooldown', () => {
  const s = new CreatureSim(stubMap(), rng);
  s.addCreatures([creatureAt('a', 100, 100)]);
  // Player centered within CONTACT_RANGE of the creature center.
  const p = player('u1', 110, 100);
  s.tick(0.05, new Set(['0,0']), [p]); // acquire + first hit
  assert.equal(p.hp, 100 - CREATURE_DAMAGE, 'took one hit');
  s.tick(0.05, new Set(['0,0']), [p]); // still on cooldown → no hit
  assert.equal(p.hp, 100 - CREATURE_DAMAGE);
  // Advance past the cooldown.
  s.tick(CREATURE_ATTACK_COOLDOWN, new Set(['0,0']), [p]);
  assert.equal(p.hp, 100 - 2 * CREATURE_DAMAGE, 'hit again after cooldown');
});

test('no player in aggro → creature roams (unchanged), no damage', () => {
  const s = new CreatureSim(stubMap(), rng);
  s.addCreatures([creatureAt('a', 100, 100)]);
  const far = player('u1', 100 + AGGRO_RADIUS + 500, 100);
  const before = { ...s.all()[0] };
  s.tick(0.1, new Set(['0,0']), [far]);
  assert.equal(s.all()[0].mode, 'roam');
  assert.equal(far.hp, 100);
  // still moved (roam), i.e. it ticked
  assert.ok(s.all()[0].x !== before.x || s.all()[0].y !== before.y);
});

test('applyAttack damages in-range creatures and removes the dead, returning their ids', () => {
  const s = new CreatureSim(stubMap(), rng);
  s.addCreatures([creatureAt('near', 100, 100, 8), creatureAt('far', 100000, 100000, 8)]);
  const killed = s.applyAttack(120, 120, 90, 10); // near center ~ (124,124), within 90
  assert.deepEqual(killed, ['near']);
  assert.ok(!s.has('near'));
  assert.ok(s.has('far'));
});

test('applyAttack only wounds (not kills) a creature with more hp', () => {
  const s = new CreatureSim(stubMap(), rng);
  s.addCreatures([creatureAt('a', 100, 100, 30)]);
  const killed = s.applyAttack(124, 124, 90, 10);
  assert.deepEqual(killed, []);
  assert.equal(s.all()[0].hp, 20);
});

test('snapshotForNeighborhood includes maxHp and mode', () => {
  const s = new CreatureSim(stubMap(), rng);
  s.addCreatures([creatureAt('a', 100, 100, 10)]);
  const snap = s.snapshotForNeighborhood(new Set(['0,0']));
  assert.equal(snap[0].maxHp, 10);
  assert.equal(snap[0].mode, 'roam');
});
