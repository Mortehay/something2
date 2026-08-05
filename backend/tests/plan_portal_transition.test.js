const test = require('node:test');
const assert = require('node:assert');
const { planPortalTransition, isPortalBlocked, knockbackPosition } = require('../src/authority/server.js');

function portalLinksWith(entries) {
  // Keyed exactly as the real world-load code keys it: "gRow,gCol" of the
  // portal's own from_x/from_y, tile-floored.
  return new Map(entries.map((e) => [`${e.gRow},${e.gCol}`, e]));
}

// gRow:5, gCol:5 with this chunkSize lands in chunk "0,0" -- matches the
// real code's chunkOf formula (cx = floor(gCol/chunkSize), cy = floor(gRow/
// chunkSize)). The gate requires the FULL radius-1 neighborhood around that
// chunk (widened after review: insertPortalGuards can place a guard in an
// ADJACENT chunk, not just the one the portal's own tile falls in), so this
// is every key in that 3x3 block -- the default "world state here has
// already loaded" fixture for every test that isn't specifically exercising
// the chunk-load gate.
const CHUNK_SIZE = 8;
const LOADED_HERE = new Set([
  '-1,-1', '0,-1', '1,-1',
  '-1,0', '0,0', '1,0',
  '-1,1', '0,1', '1,1',
]);

test('no portal at this tile returns null', () => {
  const links = portalLinksWith([{ gRow: 5, gCol: 5, id: 'link-1', toWorldId: 'w2', toX: 50, toY: 50 }]);
  const result = planPortalTransition({
    gRow: 1, gCol: 1, portalLinks: links, now: 1000, cdUntil: 0, creatures: [],
    loadedChunks: LOADED_HERE, chunkSize: CHUNK_SIZE, lastPortalTile: null,
  });
  assert.strictEqual(result, null);
});

test('a portal on cooldown returns null even though the tile matches', () => {
  const links = portalLinksWith([{ gRow: 5, gCol: 5, id: 'link-1', toWorldId: 'w2', toX: 50, toY: 50 }]);
  const result = planPortalTransition({
    gRow: 5, gCol: 5, portalLinks: links, now: 1000, cdUntil: 2000, creatures: [],
    loadedChunks: LOADED_HERE, chunkSize: CHUNK_SIZE, lastPortalTile: null,
  });
  assert.strictEqual(result, null);
});

test('an unblocked portal returns the transition', () => {
  const links = portalLinksWith([{ gRow: 5, gCol: 5, id: 'link-1', toWorldId: 'w2', toX: 50, toY: 50 }]);
  const result = planPortalTransition({
    gRow: 5, gCol: 5, portalLinks: links, now: 1000, cdUntil: 0, creatures: [],
    loadedChunks: LOADED_HERE, chunkSize: CHUNK_SIZE, lastPortalTile: null,
  });
  assert.deepStrictEqual(result, { toWorldId: 'w2', arriveX: 50, arriveY: 50 });
});

test('a portal with a living blocking guard returns blocked, not a transition', () => {
  const links = portalLinksWith([{ gRow: 5, gCol: 5, id: 'link-1', toWorldId: 'w2', toX: 50, toY: 50 }]);
  const creatures = [{ id: 'g1', hp: 50, blocksPortalId: 'link-1' }];
  const result = planPortalTransition({
    gRow: 5, gCol: 5, portalLinks: links, now: 1000, cdUntil: 0, creatures,
    loadedChunks: LOADED_HERE, chunkSize: CHUNK_SIZE, lastPortalTile: null,
  });
  assert.deepStrictEqual(result, { blocked: true, linkId: 'link-1' });
});

test('a portal whose guard already died returns the transition (unblocks the instant hp hits 0)', () => {
  const links = portalLinksWith([{ gRow: 5, gCol: 5, id: 'link-1', toWorldId: 'w2', toX: 50, toY: 50 }]);
  const creatures = [{ id: 'g1', hp: 0, blocksPortalId: 'link-1' }];
  const result = planPortalTransition({
    gRow: 5, gCol: 5, portalLinks: links, now: 1000, cdUntil: 0, creatures,
    loadedChunks: LOADED_HERE, chunkSize: CHUNK_SIZE, lastPortalTile: null,
  });
  assert.deepStrictEqual(result, { toWorldId: 'w2', arriveX: 50, arriveY: 50 });
});

test('a living guard blocking a DIFFERENT portal does not block this one', () => {
  const links = portalLinksWith([{ gRow: 5, gCol: 5, id: 'link-1', toWorldId: 'w2', toX: 50, toY: 50 }]);
  const creatures = [{ id: 'g1', hp: 50, blocksPortalId: 'link-999' }];
  const result = planPortalTransition({
    gRow: 5, gCol: 5, portalLinks: links, now: 1000, cdUntil: 0, creatures,
    loadedChunks: LOADED_HERE, chunkSize: CHUNK_SIZE, lastPortalTile: null,
  });
  assert.deepStrictEqual(result, { toWorldId: 'w2', arriveX: 50, arriveY: 50 },
    'this proves the linkage is the FK, not proximity -- an unrelated live guard must not block an unrelated portal');
});

test('isPortalBlocked is true only for a living creature referencing that exact link', () => {
  assert.equal(isPortalBlocked([{ hp: 50, blocksPortalId: 'a' }], 'a'), true);
  assert.equal(isPortalBlocked([{ hp: 0, blocksPortalId: 'a' }], 'a'), false, 'dead guard does not block');
  assert.equal(isPortalBlocked([{ hp: 50, blocksPortalId: 'b' }], 'a'), false, 'wrong link does not block');
  assert.equal(isPortalBlocked([], 'a'), false);
  assert.equal(isPortalBlocked([{ hp: 50, blocksPortalId: null }], 'a'), false);
});

test('a pack blocks until every member is dead', () => {
  const creatures = [
    { id: 'g1', hp: 0, blocksPortalId: 'link-1' },
    { id: 'g2', hp: 30, blocksPortalId: 'link-1' },
  ];
  assert.equal(isPortalBlocked(creatures, 'link-1'), true, 'one survivor still blocks');
  creatures[1].hp = 0;
  assert.equal(isPortalBlocked(creatures, 'link-1'), false, 'the last one dying unblocks it');
});

// ---------------------------------------------------------------------------
// Chunk-load gate: a creature's chunk loads asynchronously, so `creatures`
// can be an incomplete snapshot. A guard that is alive in the DB but whose
// chunk hasn't finished loading yet must not be silently treated as absent.
//
// The gate covers the portal tile's FULL radius-1 chunk neighborhood, not
// just the single chunk its own tile falls in -- insertPortalGuards spreads
// a pack up to +/-60px (RING_OFFSETS), enough to land a guard in an
// ADJACENT chunk when the portal sits near a chunk boundary. A single-chunk
// gate would consider the portal's world state "loaded" the moment its own
// chunk resolves, even while a guard one chunk over is still in flight.
// ---------------------------------------------------------------------------

test('a portal whose own chunk has not finished loading is blocked, even with zero creatures in scope', () => {
  const links = portalLinksWith([{ gRow: 5, gCol: 5, id: 'link-1', toWorldId: 'w2', toX: 50, toY: 50 }]);
  const result = planPortalTransition({
    gRow: 5, gCol: 5, portalLinks: links, now: 1000, cdUntil: 0, creatures: [],
    loadedChunks: new Set(), chunkSize: CHUNK_SIZE, lastPortalTile: null,
  });
  assert.deepStrictEqual(result, { blocked: true, linkId: 'link-1' },
    'an unloaded chunk must fail closed even for an unguarded portal -- the creature scan cannot be trusted yet');
});

test('the portal\'s OWN chunk being loaded is not enough -- a still-loading NEIGHBOR chunk still blocks', () => {
  const links = portalLinksWith([{ gRow: 5, gCol: 5, id: 'link-1', toWorldId: 'w2', toX: 50, toY: 50 }]);
  const result = planPortalTransition({
    gRow: 5, gCol: 5, portalLinks: links, now: 1000, cdUntil: 0, creatures: [],
    // Only the portal's own chunk ("0,0") is loaded; every OTHER chunk in
    // its radius-1 neighborhood (where a spread-out guard could be) is
    // still missing. This is exactly the narrower gate Gap 2 review found:
    // checking only "0,0" would have returned a clear transition here.
    loadedChunks: new Set(['0,0']), chunkSize: CHUNK_SIZE, lastPortalTile: null,
  });
  assert.deepStrictEqual(result, { blocked: true, linkId: 'link-1' },
    'a guard placed by insertPortalGuards can land in an ADJACENT chunk (RING_OFFSETS spreads up to +/-60px) -- the gate must cover the whole neighborhood, not just the tile\'s own chunk');
});

test('a portal fires normally once its FULL chunk neighborhood has finished loading', () => {
  const links = portalLinksWith([{ gRow: 5, gCol: 5, id: 'link-1', toWorldId: 'w2', toX: 50, toY: 50 }]);
  const result = planPortalTransition({
    gRow: 5, gCol: 5, portalLinks: links, now: 1000, cdUntil: 0, creatures: [],
    loadedChunks: LOADED_HERE, chunkSize: CHUNK_SIZE, lastPortalTile: null,
  });
  assert.deepStrictEqual(result, { toWorldId: 'w2', arriveX: 50, arriveY: 50 });
});

test('an unrelated loaded chunk does not satisfy the gate -- it must be THIS neighborhood specifically', () => {
  const links = portalLinksWith([{ gRow: 5, gCol: 5, id: 'link-1', toWorldId: 'w2', toX: 50, toY: 50 }]);
  const result = planPortalTransition({
    gRow: 5, gCol: 5, portalLinks: links, now: 1000, cdUntil: 0, creatures: [],
    loadedChunks: new Set(['9,9']), chunkSize: CHUNK_SIZE, lastPortalTile: null,
  });
  assert.deepStrictEqual(result, { blocked: true, linkId: 'link-1' });
});

// ---------------------------------------------------------------------------
// Just-arrived latch: a mirrored portal pair's arrival tile IS the return
// portal's own trigger tile (setPortalLink writes it that way by
// construction). Without a latch, the very next tick loop pass would bounce
// a freshly-arrived player straight back before they could do anything.
// ---------------------------------------------------------------------------

test('a portal does not fire when the player is still standing on the tile they just warped in on', () => {
  const links = portalLinksWith([{ gRow: 5, gCol: 5, id: 'link-1', toWorldId: 'w2', toX: 50, toY: 50 }]);
  const result = planPortalTransition({
    gRow: 5, gCol: 5, portalLinks: links, now: 1000, cdUntil: 0, creatures: [],
    loadedChunks: LOADED_HERE, chunkSize: CHUNK_SIZE, lastPortalTile: '5,5',
  });
  assert.strictEqual(result, null, 'the latch must suppress the portal entirely -- no transition, no blocked bounce');
});

test('the latch is scoped to the exact tile -- a different lastPortalTile does not suppress', () => {
  const links = portalLinksWith([{ gRow: 5, gCol: 5, id: 'link-1', toWorldId: 'w2', toX: 50, toY: 50 }]);
  const result = planPortalTransition({
    gRow: 5, gCol: 5, portalLinks: links, now: 1000, cdUntil: 0, creatures: [],
    loadedChunks: LOADED_HERE, chunkSize: CHUNK_SIZE, lastPortalTile: '9,9',
  });
  assert.deepStrictEqual(result, { toWorldId: 'w2', arriveX: 50, arriveY: 50 },
    'the caller is responsible for clearing lastPortalTile once the player leaves the tile; this proves the pure function honours whatever it is handed');
});

test('knockbackPosition pushes away from the portal along the approach line', () => {
  const map = { isWalkable: () => true };
  const result = knockbackPosition({ px: 1000, py: 1000, portalX: 1050, portalY: 1050, distance: 60, map });
  // The player approached from the -x,-y direction relative to the portal;
  // knockback continues that same direction, away from the portal.
  assert.ok(result.x < 1000, `expected knockback further in -x, got ${result.x}`);
  assert.ok(result.y < 1000, `expected knockback further in -y, got ${result.y}`);
});

test('knockbackPosition never lands on an unwalkable tile -- falls back to no movement', () => {
  const map = { isWalkable: () => false };
  const result = knockbackPosition({ px: 1000, py: 1000, portalX: 1050, portalY: 1050, distance: 60, map });
  assert.deepStrictEqual(result, { x: 1000, y: 1000 },
    'if the candidate tile is not walkable, do not move the player rather than shove them into a wall');
});

test('knockbackPosition with player and portal at the identical point still returns a finite position', () => {
  const map = { isWalkable: () => true };
  const result = knockbackPosition({ px: 1050, py: 1050, portalX: 1050, portalY: 1050, distance: 60, map });
  assert.ok(Number.isFinite(result.x) && Number.isFinite(result.y),
    'a zero-length approach vector must not produce NaN from a divide-by-zero normalize');
});
