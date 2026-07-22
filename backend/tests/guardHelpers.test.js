const test = require('node:test');
const assert = require('node:assert');
const { villageGatePosts } = require('../src/services/mapService');
const { selectGuardTarget, withinLeash } = require('../src/authority/creatures');

const V = (over = {}) => ({ minRow: 5, minCol: 5, width: 8, height: 6, gateEdge: 'S', ...over });

test('villageGatePosts returns the two interior tiles flanking a S gate', () => {
  // box rows 5..10, cols 5..12; gate at row 10, col 5+floor(8/2)=9
  // interior row just inside the S wall is 9; flanking cols 8 and 10
  const posts = villageGatePosts(V());
  assert.deepEqual(posts, [
    { x: 8 * 100 + 50, y: 9 * 100 + 50 },
    { x: 10 * 100 + 50, y: 9 * 100 + 50 },
  ]);
});

test('villageGatePosts handles a W gate (flanks vertically, one col inside)', () => {
  // gate at col 5, row 5+floor(6/2)=8; interior col 6; flanking rows 7 and 9
  const posts = villageGatePosts(V({ gateEdge: 'W' }));
  assert.deepEqual(posts, [
    { x: 6 * 100 + 50, y: 7 * 100 + 50 },
    { x: 6 * 100 + 50, y: 9 * 100 + 50 },
  ]);
});

test('villageGatePosts clamps into the interior for a minimum-size village', () => {
  // 3x3 box rows 5..7 cols 5..7: interior is the single tile (6,6)
  const posts = villageGatePosts(V({ width: 3, height: 3, gateEdge: 'S' }));
  for (const p of posts) {
    assert.equal(p.x, 6 * 100 + 50);
    assert.equal(p.y, 6 * 100 + 50);
  }
});

test('withinLeash is unconstrained when there is no home anchor', () => {
  assert.equal(withinLeash(9999, 9999, null, 300), true);
  assert.equal(withinLeash(100, 100, { x: 100, y: 100 }, 300), true);
  assert.equal(withinLeash(500, 100, { x: 100, y: 100 }, 300), false);
});

test('selectGuardTarget picks the nearest hostile creature and ignores guards', () => {
  const guard = { x: 100, y: 100, width: 48, height: 48, home: { x: 100, y: 100 } };
  const creatures = [
    { id: 'far',  faction: 'hostile', x: 300, y: 100, width: 48, height: 48 },
    { id: 'near', faction: 'hostile', x: 200, y: 100, width: 48, height: 48 },
    { id: 'g2',   faction: 'guard',   x: 110, y: 100, width: 48, height: 48 },
  ];
  const t = selectGuardTarget({ guard, creatures, aggroRadius: 400, leashRadius: 300 });
  assert.equal(t.id, 'near');
});

test('selectGuardTarget ignores hostiles beyond the leash from home', () => {
  const guard = { x: 100, y: 100, width: 48, height: 48, home: { x: 100, y: 100 } };
  const creatures = [{ id: 'far', faction: 'hostile', x: 1000, y: 100, width: 48, height: 48 }];
  assert.equal(selectGuardTarget({ guard, creatures, aggroRadius: 4000, leashRadius: 300 }), null);
});

test('selectGuardTarget returns null when there are no hostiles', () => {
  const guard = { x: 100, y: 100, width: 48, height: 48, home: { x: 100, y: 100 } };
  assert.equal(selectGuardTarget({ guard, creatures: [], aggroRadius: 400, leashRadius: 300 }), null);
});

// --- Coverage closed after task review: the N and E gate branches and the
// self-exclusion clause had no test. Guards flanking the wrong tile would put
// them outside the village or inside a wall, so every edge gets an oracle.

test('villageGatePosts returns the two interior tiles flanking an N gate', () => {
  // box rows 5..10, cols 5..12; gate at row 5 (minRow), col 5+floor(8/2)=9
  // interior row just inside the N wall is 6; flanking cols 8 and 10
  const posts = villageGatePosts(V({ gateEdge: 'N' }));
  assert.deepEqual(posts, [
    { x: 8 * 100 + 50, y: 6 * 100 + 50 },
    { x: 10 * 100 + 50, y: 6 * 100 + 50 },
  ]);
});

test('villageGatePosts returns the two interior tiles flanking an E gate', () => {
  // gate at col 12 (cMax), row 5+floor(6/2)=8; interior col 11; flanking rows 7 and 9
  const posts = villageGatePosts(V({ gateEdge: 'E' }));
  assert.deepEqual(posts, [
    { x: 11 * 100 + 50, y: 7 * 100 + 50 },
    { x: 11 * 100 + 50, y: 9 * 100 + 50 },
  ]);
});

test('a guard present in the creature list is never selected as its own target', () => {
  const guard = { id: 'self', faction: 'guard', x: 100, y: 100, width: 48, height: 48, home: { x: 100, y: 100 } };
  // The guard itself is the CLOSEST entry in the list; only the self/faction
  // exclusions stop it winning over the hostile 100px away.
  const creatures = [guard, { id: 'h', faction: 'hostile', x: 200, y: 100, width: 48, height: 48 }];
  const t = selectGuardTarget({ guard, creatures, aggroRadius: 400, leashRadius: 300 });
  assert.equal(t.id, 'h');
});
