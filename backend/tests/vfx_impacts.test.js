const test = require('node:test');
const assert = require('node:assert');
const { World } = require('../src/authority/world.js');

// Slice C (SOMET-160): frame.impacts lists exactly the damaged targets, and is
// absent when nothing was hit. The design says this "exposes a fact" the
// authority already computed -- these assert it exposes the RIGHT one.

const TYPES = new Map([
  [1, {
    id: 1, name: 'dagger', category: 'weapon', kind: 'melee', slot: 'main_hand',
    damage: 5, cooldown: 0, reach: 200, arc_width: 3.0, element: null,
    resistances: {}, defense: 0, vfx: { attack: 'sweep_arc', impact: 'spark_hit' },
  }],
  [2, {
    id: 2, name: 'flame staff', category: 'weapon', kind: 'melee', slot: 'main_hand',
    damage: 5, cooldown: 0, reach: 200, arc_width: 3.0, element: 'fire',
    resistances: {}, defense: 0, vfx: { attack: 'sweep_arc', impact: 'spark_fire' },
  }],
]);

function armWorld() {
  const map = { chunkSize: 8, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] };
  return new World(map, TYPES, 1);
}
const inv = (typeId) => ({ items: [{ id: 'i1', typeId }], equipment: { main_hand: 'i1' } });

test('a swing that hits nothing reports an EMPTY impacts list', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, inv(1));
  const r = w.attack('u1', 1, 0);
  assert.deepEqual(r.impacts, [], 'server.js omits the frame key entirely for an empty list');
});

test('impacts lists exactly the damaged creatures, at their positions', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, inv(1));   // centre 132,132
  w.creatures.addCreatures([
    { id: 'near', type: 'Wolf', x: 200, y: 120, hp: 50, facing: 'S', color: '#c00' },
    // Far outside a 200-unit reach: must NOT appear.
    { id: 'far', type: 'Wolf', x: 900, y: 900, hp: 50, facing: 'S', color: '#c00' },
  ]);
  const r = w.attack('u1', 1, 0);

  assert.equal(r.impacts.length, 1, 'exactly the damaged target, not every creature in the world');
  assert.equal(r.impacts[0].t, 'c:near');
  // The creature's CENTRE (48px box), not its stored top-left -- a spark at
  // the corner reads as missing the target it just hit.
  assert.equal(r.impacts[0].x, 224);
  assert.equal(r.impacts[0].y, 144);
});

test('a target KILLED by the swing still reports its impact', () => {
  // The position is captured BEFORE the kill for exactly this reason: a
  // one-shot kill removes the creature, and reading afterwards would give
  // nothing for precisely the hits that matter most.
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, inv(1));
  w.creatures.addCreatures([{ id: 'doomed', type: 'Wolf', x: 200, y: 120, hp: 1, facing: 'S', color: '#c00' }]);
  const r = w.attack('u1', 1, 0);

  assert.equal(r.kills.length, 1, 'sanity: it really did die');
  assert.equal(r.impacts.length, 1, 'a fatal hit is still a hit');
  assert.equal(r.impacts[0].t, 'c:doomed');
});

test('impacts carry the resolved effect name and the EFFECTIVE element', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, inv(2));   // catalog element: fire
  w.creatures.addCreatures([{ id: 'burned', type: 'Wolf', x: 200, y: 120, hp: 50, facing: 'S', color: '#c00' }]);
  const r = w.attack('u1', 1, 0);

  assert.equal(r.impacts[0].v, 'spark_fire', 'resolved SERVER-side; the client has no weapon catalog');
  // 'physical', NOT 'fire', and that is correct: Magic Stones gave bare magic
  // weapons replace semantics (items.js activeWeaponType), so a flame staff
  // with no spell stone socketed deals physical damage. The tint must follow
  // the element the swing ACTUALLY had, not the one printed in the catalog --
  // this assertion is why the migration binds the neutral spark to every
  // weapon and lets the tint vary, instead of binding an elemental spark per
  // catalog element.
  assert.equal(r.impacts[0].el, 'physical',
    'the EFFECTIVE element of the swing, which a bare magic weapon converts to physical');
});

test('a physical weapon reports a null element rather than omitting the field', () => {
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, inv(1));
  w.creatures.addCreatures([{ id: 'c', type: 'Wolf', x: 200, y: 120, hp: 50, facing: 'S', color: '#c00' }]);
  assert.equal(w.attack('u1', 1, 0).impacts[0].el, null);
});

test('players damaged by the swing appear alongside creatures, prefixed p:', () => {
  // One event kind, distinguished only by the id prefix, so the client draws
  // both through one path.
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, inv(1));
  w.addPlayer('u2', { x: 200, y: 110 }, inv(1));
  w.creatures.addCreatures([{ id: 'c', type: 'Wolf', x: 200, y: 120, hp: 50, facing: 'S', color: '#c00' }]);
  const r = w.attack('u1', 1, 0);

  const ids = r.impacts.map((i) => i.t).sort();
  assert.deepEqual(ids, ['c:c', 'p:u2']);
});

test('a refused attack (cooldown) reports impacts as an empty list, not undefined', () => {
  // Every early return carries the same shape, so no caller has to guard.
  const w = armWorld();
  w.addPlayer('u1', { x: 100, y: 100 }, inv(1));
  w.players.get('u1')._attackCd = 5;
  assert.deepEqual(w.attack('u1', 1, 0).impacts, []);
});
