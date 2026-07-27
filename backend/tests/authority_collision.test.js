const test = require('node:test');
const assert = require('node:assert');
const { resolveMove, ServerMap, MAP_TILE_SIZE, MAX_CHUNKS } = require('../src/authority/collision.js');

// --- Footprint collision golden vectors ---------------------------------
// A column-based wall stub: tile column `blockedCol` (world x in
// [blockedCol*100, blockedCol*100+100)) is unwalkable; everything else walks.
function wallColumn(blockedCol) {
  return {
    isWalkable: (wx) => Math.floor(wx / 100) !== blockedCol,
    speedAt: () => 1,
  };
}
// A gate stub: ONLY tile column `openCol` is walkable (walls on both sides).
function gateColumn(openCol) {
  return {
    isWalkable: (wx) => Math.floor(wx / 100) === openCol,
    speedAt: () => 1,
  };
}

test('footprint blocks when the box FRONT reaches a wall even though the CENTER has not', () => {
  // Box 64 wide at x=0 -> center 32, front face 64. Wall in column 1 (x>=100).
  // Step east 40: center reaches 72 (still column 0, walkable) but the front
  // face reaches 104 (column 1) -> footprint blocks. Center-point logic moved.
  const actor = { x: 0, y: 0, width: 64, height: 64, speed: 40 };
  const r = resolveMove(wallColumn(1), actor, 1, 0, 1);
  assert.deepEqual(r, { x: 0, y: 0, moved: false });
});

test('footprint lets an actor already overlapping a wall move AWAY from it', () => {
  // Box sits at x=108 (spans 108..172), embedded in wall column 1. Moving west
  // 40: the west leading edge reaches 68 (column 0, walkable) -> allowed.
  const actor = { x: 108, y: 0, width: 64, height: 64, speed: 40 };
  const r = resolveMove(wallColumn(1), actor, -1, 0, 1);
  assert.deepEqual(r, { x: 68, y: 0, moved: true });
});

test('a 64-wide box threads a 100px-wide gate', () => {
  // Gate = walkable column 1 only. Box centered in it (x=118, spans 118..182,
  // both corners in column 1). Moving south 40 stays in the gate -> passes.
  const actor = { x: 118, y: 150, width: 64, height: 64, speed: 40 };
  const r = resolveMove(gateColumn(1), actor, 0, 1, 1);
  assert.deepEqual(r, { x: 118, y: 190, moved: true });
});

// Stub map: everything walkable at speed 1 unless (wx,wy) falls in a blocked band.
function stubMap({ blockX = null } = {}) {
  return {
    isWalkable: (wx) => (blockX === null ? true : wx < blockX),
    speedAt: () => 1,
  };
}

test('resolveMove is a no-op on zero input', () => {
  const r = resolveMove(stubMap(), { x: 10, y: 20, width: 64, height: 64, speed: 200 }, 0, 0, 0.05);
  assert.deepEqual(r, { x: 10, y: 20, moved: false });
});

test('resolveMove normalizes diagonals (not faster than an axis)', () => {
  const actor = { x: 0, y: 0, width: 0, height: 0, speed: 100 };
  const diag = resolveMove(stubMap(), actor, 1, 1, 1);
  // step = (1/sqrt2)*100*1 ≈ 70.71 on each axis
  assert.ok(Math.abs(diag.x - 70.7106) < 1e-3);
  assert.ok(Math.abs(diag.y - 70.7106) < 1e-3);
});

test('resolveMove blocks the X axis at a wall but allows Y (footprint)', () => {
  // Box 64 at (0,0) -> center (32,32). Wall column 1 (x>=100). Moving NE:
  // the east leading edge enters column 1 (blocked), but the box's full width
  // (0..64) stays in column 0 for the Y move, so Y is free.
  const actor = { x: 0, y: 0, width: 64, height: 64, speed: 200 };
  const r = resolveMove(wallColumn(1), actor, 1, 1, 0.5);
  assert.equal(r.x, 0);              // x blocked by the wall column
  assert.ok(r.y > 0);               // y slides free
  assert.equal(r.moved, true);
});

test('ServerMap resolves tiles, walkability and speed incl. negative coords', () => {
  const world = {
    seed: 7,
    chunkSize: 8,
    tileTypes: { grass: { walkable: true, speed: 1 }, water: { walkable: false, speed: 1 } },
  };
  const map = new ServerMap(world);
  // A generated tile name is one of the tileTypes keys.
  const name = map.getTileAt(-50, -50);
  assert.ok(name === 'grass' || name === 'water', `unexpected tile ${name}`);
  // Walkability follows the tile def.
  const walk = map.isWalkable(-50, -50);
  assert.equal(walk, world.tileTypes[name].walkable !== false);
  // Default speed is 1.
  assert.equal(map.speedAt(-50, -50), 1);
  // Chunk ownership: (-50,-50) world px → global tile (-1,-1) → chunk (-1,-1).
  const g = map.getChunk(-1, -1);
  assert.equal(g.length, 8);
});

// A ServerMap over an all-grass world so getChunk always succeeds.
function lruMap() {
  return new ServerMap({
    seed: 1,
    chunkSize: 8,
    tileTypes: { grass: { walkable: true, speed: 1 } },
  });
}

test('ServerMap.chunks is bounded at MAX_CHUNKS (evicts the oldest)', () => {
  const m = lruMap();
  // Request MAX_CHUNKS distinct chunks (row 0, cols 0..MAX_CHUNKS-1).
  for (let cx = 0; cx < MAX_CHUNKS; cx++) m.getChunk(cx, 0);
  assert.equal(m.chunks.size, MAX_CHUNKS);
  assert.ok(m.chunks.has('0,0'), 'oldest still present at exactly cap');
  // One more distinct chunk pushes past the cap → oldest ('0,0') evicted.
  m.getChunk(MAX_CHUNKS, 0);
  assert.equal(m.chunks.size, MAX_CHUNKS);
  assert.ok(!m.chunks.has('0,0'), 'oldest chunk evicted past cap');
  assert.ok(m.chunks.has(`${MAX_CHUNKS},0`), 'newest chunk present');
});

test('ServerMap.getChunk refreshes recency so a re-touched chunk survives eviction', () => {
  const m = lruMap();
  for (let cx = 0; cx < MAX_CHUNKS; cx++) m.getChunk(cx, 0);
  // Re-touch the oldest key so it becomes newest.
  m.getChunk(0, 0);
  // Now insert a new distinct chunk → the *next*-oldest ('1,0') is evicted, not '0,0'.
  m.getChunk(MAX_CHUNKS, 0);
  assert.ok(m.chunks.has('0,0'), 're-touched chunk survives');
  assert.ok(!m.chunks.has('1,0'), 'next-oldest evicted instead');
});

test('evicted chunk regenerates identically (eviction is memory-only)', () => {
  const m = lruMap();
  const first = m.getChunk(0, 0);
  const snapshot = JSON.stringify(first);
  for (let cx = 1; cx <= MAX_CHUNKS; cx++) m.getChunk(cx, 0); // evicts '0,0'
  assert.ok(!m.chunks.has('0,0'));
  const regen = m.getChunk(0, 0);
  assert.equal(JSON.stringify(regen), snapshot, 'regenerated chunk is identical');
});
