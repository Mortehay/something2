const test = require('node:test');
const assert = require('node:assert');
const { resolveMove, ServerMap, MAP_TILE_SIZE, MAX_CHUNKS } = require('../src/authority/collision.js');
const { generateChunk, generateChunkDecorations } = require('../src/services/mapService');

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

// A single wall TILE (not a column): unwalkable only where BOTH column and row
// match, so it depends on wy — unlike wallColumn/gateColumn. This lets the two
// leading-edge corner checks disagree, pinning the TWO-corner footprint: a
// one-corner regression would let this vector move.
function wallTile(col, row) {
  return {
    isWalkable: (wx, wy) => !(Math.floor(wx / 100) === col && Math.floor(wy / 100) === row),
    speedAt: () => 1,
  };
}

// SOMET-337: the samples come from the FOOTPRINT, not the sprite box —
// FOOTPRINT_SCALE 0.5, so a 64x64 actor tests a 32x32 box centred on the same
// anchor (half-extent 16). Every expectation below is derived from that
// geometry by hand; none is read back out of the implementation.

test('footprint tests BOTH leading-edge corners (one corner in a wall tile blocks)', () => {
  // Box 64x64 at (40,68) -> centre (72,100), footprint half-extent 16.
  // East step 40: leading face 72+16=88 -> destination 128, column 1.
  // The two corner samples STRADDLE the row line: top 100-16+EPS=84.01 is
  // row 0 (open), bottom 100+16-EPS=115.99 is row 1, the wall tile. So the
  // two-corner test blocks and the step clamps to the face at 100-EPS:
  // x moves 99.99-88 = 11.99, to 51.99. A one-corner (top-only) regression
  // would take the whole step and land at 80.
  const actor = { x: 40, y: 68, width: 64, height: 64, speed: 40 };
  const r = resolveMove(wallTile(1, 1), actor, 1, 0, 1);
  assert.ok(Math.abs(r.x - 51.99) < 1e-6, `x=${r.x}`);
  assert.equal(r.y, 68);
  assert.equal(r.moved, true);
});

test('a blocked step CLAMPS the footprint up to the wall face (not reject)', () => {
  // Box at x=20 -> centre 52, east footprint face 52+16=68. Wall column 1
  // (x>=100). Step east 40 would put that face at 108, inside the wall; clamp
  // it to 100-EPS instead, so x advances 99.99-68 = 31.99, to 51.99.
  const actor = { x: 20, y: 0, width: 64, height: 64, speed: 40 };
  const r = resolveMove(wallColumn(1), actor, 1, 0, 1);
  assert.ok(Math.abs(r.x - 51.99) < 1e-6, `x=${r.x}`);
  // The invariant behind the number: the footprint's leading face lands EPS
  // shy of the tile line, whatever the box size.
  assert.ok(Math.abs((r.x + 32 + 16) - 99.99) < 1e-6, `face=${r.x + 48}`);
  assert.equal(r.y, 0);
  assert.equal(r.moved, true);
});

test('footprint lets an actor already overlapping a wall move AWAY from it', () => {
  // Box at x=108 (centre 140), embedded in wall column 1. Moving west 40: the
  // west footprint face 140-16=124 reaches 84, column 0 and walkable -> the
  // full step is allowed. Unchanged by the footprint scale: both the old
  // full-box face (108) and the new one (124) sit inside the wall column.
  const actor = { x: 108, y: 0, width: 64, height: 64, speed: 40 };
  const r = resolveMove(wallColumn(1), actor, -1, 0, 1);
  assert.deepEqual(r, { x: 68, y: 0, moved: true });
});

test('the FOOTPRINT decides whether an actor fits, not the sprite box', () => {
  // Gate = walkable column 1 only. Box at x=88 spans 88..152, so its LEFT box
  // corner (88) is in wall column 0 — the pre-SOMET-337 full-box test blocked
  // here. The footprint spans centre 120 +/-16 = 104..136, wholly inside the
  // gate, so both samples (104.01, 135.99) are walkable and the south step of
  // 40 goes through in full.
  const actor = { x: 88, y: 150, width: 64, height: 64, speed: 40 };
  const r = resolveMove(gateColumn(1), actor, 0, 1, 1);
  assert.deepEqual(r, { x: 88, y: 190, moved: true });
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

test('X clamps to the wall face while Y slides free (footprint)', () => {
  // Box 64x64 at (0,0) -> centre 32, east footprint face 48. Wall column 1.
  // Moving NE at speed 200 for 0.5s: each axis steps 70.71 (normalized), so
  // the east face would reach 118.71 -> clamp to 100-EPS, x advances
  // 99.99-48 = 51.99. Y is free: its samples (16.01, 47.99) are column 0.
  const actor = { x: 0, y: 0, width: 64, height: 64, speed: 200 };
  const r = resolveMove(wallColumn(1), actor, 1, 1, 0.5);
  assert.ok(Math.abs(r.x - 51.99) < 1e-6, `x=${r.x}`); // clamped, not 0
  assert.ok(r.y > 0);                                   // y slides free
  assert.equal(r.moved, true);
});

test('collision is dt-invariant near a wall: one big step == many small steps', () => {
  // The bug: step-rejection made the stop distance depend on dt, so the client
  // (16ms) and server (50ms) disagreed near walls. Clamping makes them equal.
  const run = (dt, n) => {
    const a = { x: 0, y: 0, width: 64, height: 64, speed: 200 };
    for (let i = 0; i < n; i++) { const r = resolveMove(wallColumn(1), a, 1, 0, dt); a.x = r.x; a.y = r.y; }
    return a.x;
  };
  const big = run(0.05, 10);
  const small = run(0.05 / 3, 30);
  assert.ok(Math.abs(big - small) < 1e-9, `dt divergence: big=${big} small=${small}`);
  // Both runs settle with the footprint face at 100-EPS: x = 99.99-16-32.
  assert.ok(Math.abs(big - 51.99) < 1e-6, `x=${big}`);
});

test('flush against a wall, a parallel move slides at full speed (EPS corner inset)', () => {
  // Footprint east face EXACTLY on the tile line x=100: centre 84 (x=52,
  // width 64) + half-extent 16. Moving south along the column-1 wall must
  // advance the full step (10). Without the EPS inset the right sample at
  // exactly 100 would floor into the wall column and block.
  const r = resolveMove(wallColumn(1), { x: 52, y: 0, width: 64, height: 64, speed: 200 }, 0, 1, 0.05);
  assert.equal(r.y, 10);
  assert.equal(r.x, 52);
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

// --- Decoration overlay ---------------------------------------------------

test('ServerMap.isWalkable blocks a tile occupied by a blocking decoration', () => {
  const world = {
    seed: 999, chunkSize: 8, width: 8, height: 8,
    tileTypes: { grass: { walkable: true, speed: 1 } },
    decorationDefs: [{ name: 'Tree', walkable: false, spawn_tiles: ['grass'], chance: 1 }],
  };
  const map = new ServerMap(world);
  // Find a placed blocking decoration in chunk (0,0) and assert its tile blocks,
  // while a decoration-free grass tile stays walkable.
  const decos = generateChunkDecorations(world, 0, 0, generateChunk(world, 0, 0), world.decorationDefs);
  assert.ok(decos.length > 0, 'expected at least one decoration');
  const d = decos[0];
  const bx = d.col * 100 + 50, by = d.row * 100 + 50; // tile center, world px
  assert.equal(map.isWalkable(bx, by), false, 'decoration tile blocks');
});

test('ServerMap.isWalkable ignores a passable (walkable) decoration', () => {
  const world = {
    seed: 999, chunkSize: 8, width: 8, height: 8,
    tileTypes: { grass: { walkable: true, speed: 1 } },
    decorationDefs: [{ name: 'Bush', walkable: true, spawn_tiles: ['grass'], chance: 1 }],
  };
  const map = new ServerMap(world);
  const decos = generateChunkDecorations(world, 0, 0, generateChunk(world, 0, 0), world.decorationDefs);
  // Pick a placed passable decoration on an INTERIOR tile (avoid the 8x8 boundary walls at row/col 0 and 7).
  const p = decos.find((d) => !d.blocking && d.row > 0 && d.row < 7 && d.col > 0 && d.col < 7);
  assert.ok(p, 'expected an interior passable decoration to place');
  // Its tile must stay walkable — a passable decoration never blocks.
  assert.equal(map.isWalkable(p.col * 100 + 50, p.row * 100 + 50), true);
});

test('ServerMap.isWalkable applies the decoration overlay in a NON-zero chunk (exercises the cx/cy offset math)', () => {
  // Chunk (0,0) alone would mask a bug in isWalkable's world-px -> chunk-local
  // conversion (cx*chunkSize / cy*chunkSize terms reading as 0 either way).
  // Use a world large enough that chunk (1,0) is in-bounds and derive a
  // blocking placement there directly, then assert against its WORLD-px
  // center (chunk offset + local col/row), not chunk-local coords.
  const world = {
    seed: 999, chunkSize: 8, width: 24, height: 24,
    tileTypes: { grass: { walkable: true, speed: 1 } },
    decorationDefs: [{ name: 'Tree', walkable: false, spawn_tiles: ['grass'], chance: 1 }],
  };
  const map = new ServerMap(world);
  const decos = generateChunkDecorations(world, 1, 0, generateChunk(world, 1, 0), world.decorationDefs);
  const d = decos.find((dd) => dd.blocking);
  assert.ok(d, 'expected a blocking decoration to place in chunk (1,0)');
  const worldCol = 1 * world.chunkSize + d.col; // chunk (1,0) offset in the col axis
  const worldRow = d.row; // cy=0, no row offset
  const bx = worldCol * 100 + 50, by = worldRow * 100 + 50;
  assert.equal(map.isWalkable(bx, by), false, 'decoration tile in a non-zero chunk blocks');
});

test('ServerMap.isWalkable keeps the entry-spawn tile clear of blocking decorations (spawn-clear-radius exclusion is live end-to-end)', () => {
  // entry_spawn (row=4,col=4) sits well inside chunk (0,0) (chunkSize 8). A
  // dense (chance:1) blocking def would, absent the exclusion, very likely
  // land on the spawn tile too. generateChunkDecorations' isExcludedBlockerCell
  // keeps the spawn tile (and its Chebyshev-1 ring) clear; this proves that
  // exclusion is actually reachable through ServerMap (i.e. `entry_spawn` is
  // wired into the world config passed to `new ServerMap(...)`), not just
  // exercised when calling generateChunkDecorations directly.
  const world = {
    seed: 999, chunkSize: 8, width: 8, height: 8,
    tileTypes: { grass: { walkable: true, speed: 1 } },
    decorationDefs: [{ name: 'Tree', walkable: false, spawn_tiles: ['grass'], chance: 1 }],
    entry_spawn: { x: 450, y: 450 }, // tile center of (row=4, col=4)
  };
  const map = new ServerMap(world);
  assert.equal(map.isWalkable(450, 450), true, 'entry spawn tile must not be blocked');
  // Prove the def is actually placing (not vacuously true because nothing spawned
  // at all): some tile outside the spawn clear radius is blocked.
  const decos = generateChunkDecorations(world, 0, 0, generateChunk(world, 0, 0), world.decorationDefs);
  const blockingElsewhere = decos.some(
    (d) => d.blocking && Math.max(Math.abs(d.row - 4), Math.abs(d.col - 4)) > 1,
  );
  assert.ok(blockingElsewhere, 'expected a blocking decoration outside the spawn clear radius');
});
