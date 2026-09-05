const test = require('node:test');
const assert = require('node:assert');
const { bucketPlayersByChunk, playersNear } = require('../src/authority/playerAoi.js');
const { chunkOf, MAP_TILE_SIZE } = require('../src/authority/coords.js');

// SOMET-365. The player broadcast was the one AOI hole left: creatures, items
// and chests were already scoped to the recipient's neighbourhood, players were
// not. These tests pin the scoping itself; authority_server.test.js pins that
// the real tick loop actually uses it.
//
// chunk_size 8 with MAP_TILE_SIZE 100 makes a chunk 800 world px, which is what
// every position below is expressed in terms of -- deliberately, so a change to
// either constant moves the fixtures with it instead of silently invalidating
// them.
const N = 8;
const CHUNK_PX = N * MAP_TILE_SIZE; // 800

const row = (id, x, y) => ({ id, x, y, hp: 10 });

test('a player in a distant chunk is not in the recipient\'s list', () => {
  const me = row('me', 100, 100);
  const far = row('far', 100 + CHUNK_PX * 5, 100);
  const buckets = bucketPlayersByChunk([me, far], N);
  const got = playersNear(buckets, me.x, me.y, N, me).map((p) => p.id);
  assert.deepEqual(got, ['me'], 'a player five chunks away must not be broadcast');
});

// THE REGRESSION THAT MATTERS. Over-filtering makes other players vanish in
// ordinary co-op, which is far worse than the bandwidth it saves -- so the
// same-chunk and across-a-boundary cases are asserted separately rather than
// assumed to follow from one another.
test('players in the same chunk still see each other', () => {
  const me = row('me', 100, 100);
  const mate = row('mate', 200, 150);
  const buckets = bucketPlayersByChunk([me, mate], N);
  const got = playersNear(buckets, me.x, me.y, N, me).map((p) => p.id).sort();
  assert.deepEqual(got, ['mate', 'me']);
});

test('players in ADJACENT chunks see each other, including diagonally', () => {
  const me = row('me', CHUNK_PX + 10, CHUNK_PX + 10); // chunk (1,1)
  const east = row('east', CHUNK_PX * 2 + 10, CHUNK_PX + 10); // (2,1)
  const north = row('north', CHUNK_PX + 10, 10); // (1,0)
  const diag = row('diag', 10, 10); // (0,0) -- diagonal neighbour
  const buckets = bucketPlayersByChunk([me, east, north, diag], N);
  const got = playersNear(buckets, me.x, me.y, N, me).map((p) => p.id).sort();
  assert.deepEqual(got, ['diag', 'east', 'me', 'north']);
});

// Standing a few pixels apart across a chunk line is the everyday case that
// would break if the neighbourhood were computed from a rect instead of the
// 3x3 chunk block.
test('two players a few pixels apart but in different chunks still see each other', () => {
  const west = row('west', CHUNK_PX - 5, 400);
  const east = row('east', CHUNK_PX + 5, 400);
  assert.notDeepEqual(chunkOf(west.x, west.y, N), chunkOf(east.x, east.y, N),
    'precondition: these two must genuinely be in different chunks');
  const buckets = bucketPlayersByChunk([west, east], N);
  const got = playersNear(buckets, west.x, west.y, N, west).map((p) => p.id).sort();
  assert.deepEqual(got, ['east', 'west']);
});

test('the recipient always gets their own row -- alone, and at any position', () => {
  for (const [x, y] of [[0, 0], [1, 1], [-5000, 12345], [CHUNK_PX * 40, -CHUNK_PX * 7]]) {
    const me = row('me', x, y);
    const buckets = bucketPlayersByChunk([me], N);
    const got = playersNear(buckets, me.x, me.y, N, me);
    assert.equal(got.length, 1, `alone at ${x},${y} the recipient must still get exactly itself`);
    assert.equal(got[0], me);
  }
});

// The own-row guard must survive the bucketing being wrong, because that is the
// only case where it does anything at all. An empty bucket map stands in for
// "the snapshot did not contain me" -- prediction reconciliation reads ackSeq,
// hp, mana and equipment off this row, so its absence breaks the client
// outright rather than merely failing to draw someone.
test('the own row is included even when the buckets do not contain it', () => {
  const me = row('me', 500, 500);
  const got = playersNear(new Map(), me.x, me.y, N, me);
  assert.deepEqual(got, [me]);
});

// The reason this is bucket-once rather than filter-per-socket. The old code
// shared ONE row object across every socket by reference; a per-recipient
// .map() would have built a fresh object per player per recipient, trading a
// bandwidth problem for an allocation one. Reference identity is the only
// honest way to assert that -- a deepEqual would pass against copies.
test('row objects are SHARED by reference between recipients, never re-mapped', () => {
  const a = row('a', 100, 100);
  const b = row('b', 300, 100);
  const buckets = bucketPlayersByChunk([a, b], N);
  const forA = playersNear(buckets, a.x, a.y, N, a);
  const forB = playersNear(buckets, b.x, b.y, N, b);
  assert.equal(forA.find((p) => p.id === 'b'), b, "b's row must be the same object in a's frame");
  assert.equal(forB.find((p) => p.id === 'a'), a, "a's row must be the same object in b's frame");
});

// Bucketing must not care what a row contains. If it ever copied or re-shaped
// rows, a field added to World.snapshot() later would silently stop reaching
// the wire -- the named-field-list failure SOMET-528 hit twice.
test('rows pass through untouched, whatever fields they carry', () => {
  const odd = { id: 'x', x: 10, y: 10, aura: 120, buffs: [{ id: 'b' }], effects: ['chill'] };
  const buckets = bucketPlayersByChunk([odd], N);
  const [got] = playersNear(buckets, 10, 10, N, odd);
  assert.equal(got, odd);
  assert.deepEqual(Object.keys(got), ['id', 'x', 'y', 'aura', 'buffs', 'effects']);
});

// The one that actually proves correctness. Per-case tests above could all pass
// against an index that is subtly wrong at the edges; this compares against an
// independent brute-force rule (|dcx| <= 1 && |dcy| <= 1) rather than against
// the CHUNK_KEY/neighbourhoodKeys arithmetic the implementation itself uses --
// a test deriving its expectation from the same helpers would pass on a broken
// implementation, which is the trap SOMET-363 names explicitly.
test('matches a brute-force neighbourhood filter over random positions', () => {
  let seed = 20260903;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const span = CHUNK_PX * 6;
  for (let trial = 0; trial < 200; trial++) {
    const players = Array.from({ length: 25 }, (_, i) => row(
      `p${i}`,
      Math.round((rnd() - 0.5) * span),
      Math.round((rnd() - 0.5) * span),
    ));
    const viewer = players[0];
    const buckets = bucketPlayersByChunk(players, N);
    const got = playersNear(buckets, viewer.x, viewer.y, N, viewer)
      .map((p) => p.id).sort();

    const vc = chunkOf(viewer.x, viewer.y, N);
    const want = players.filter((p) => {
      const pc = chunkOf(p.x, p.y, N);
      return Math.abs(pc.cx - vc.cx) <= 1 && Math.abs(pc.cy - vc.cy) <= 1;
    }).map((p) => p.id).sort();

    assert.deepEqual(got, want,
      `trial ${trial}: viewer at ${viewer.x},${viewer.y} disagreed with brute force`);
  }
});
