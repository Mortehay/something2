const test = require('node:test');
const assert = require('node:assert');
const { placeCreaturePacks, generateRegion } = require('../src/services/mapService');

const TILE_TYPES = {
  grass: { walkable: true, speed: 1 },
  water: { walkable: false, speed: 1 },
};
const boundedWorld = (over = {}) => ({
  seed: 42, chunkSize: 64, tileTypes: TILE_TYPES,
  width: 24, height: 24, doorways: new Set(['N', 'E', 'S', 'W']),
  ...over,
});

const CREATURES = [
  { name: 'goblin', hp: 12, defense: 1, resistances: {} },
  { name: 'wolf', hp: 8, defense: 0, resistances: { fire: 0.5 } },
];

// Every clustering assertion below FIRST asserts the pack is non-empty and
// full size. "every member is within radius" is vacuously true of an empty
// array, so a pack function that silently placed nothing would otherwise pass
// the entire clustering suite.

test('places one full pack of the requested size', () => {
  const rows = placeCreaturePacks(boundedWorld(), [{ size: 6 }], CREATURES, 123);
  assert.equal(rows.length, 6);
});

test('a pack is a single creature type, not a mixed bag', () => {
  const rows = placeCreaturePacks(boundedWorld(), [{ size: 8 }], CREATURES, 77);
  assert.equal(rows.length, 8);
  assert.equal(new Set(rows.map((r) => r.type)).size, 1);
});

test('pack members cluster within the size-derived radius of each other', () => {
  const rows = placeCreaturePacks(boundedWorld(), [{ size: 5 }], CREATURES, 31);
  assert.equal(rows.length, 5);
  // size 5 -> radius = clamp(ceil(sqrt(5)) + 1, 2, 4) = 4, so members sit
  // within 4 tiles of the anchor and therefore within 8 of each other.
  const cols = rows.map((r) => Math.floor(r.x / 100));
  const rowsIdx = rows.map((r) => Math.floor(r.y / 100));
  assert.ok(Math.max(...cols) - Math.min(...cols) <= 8);
  assert.ok(Math.max(...rowsIdx) - Math.min(...rowsIdx) <= 8);
});

test('two packs are placed independently, not merged into one blob', () => {
  const rows = placeCreaturePacks(boundedWorld(), [{ size: 4 }, { size: 4 }], CREATURES, 909);
  assert.equal(rows.length, 8);
});

test('every member lands strictly inside the wall ring on a walkable tile', () => {
  const world = boundedWorld();
  const rows = placeCreaturePacks(world, [{ size: 10 }], CREATURES, 5150);
  assert.equal(rows.length, 10);
  for (const c of rows) {
    const col = Math.floor(c.x / 100);
    const row = Math.floor(c.y / 100);
    assert.ok(row >= 1 && row <= 22, `row ${row} inside 1..22`);
    assert.ok(col >= 1 && col <= 22, `col ${col} inside 1..22`);
    const name = generateRegion(world, row, col, 1, 1)[0][0];
    assert.notEqual(name, 'map_wall');
    assert.notEqual(name, 'map_doorway');
    assert.notEqual(TILE_TYPES[name].walkable, false);
  }
});

test('pack members occupy distinct tiles, never stacked', () => {
  const rows = placeCreaturePacks(boundedWorld(), [{ size: 10 }], CREATURES, 5150);
  assert.equal(rows.length, 10);
  const distinct = new Set(rows.map((r) => `${r.x},${r.y}`));
  assert.equal(distinct.size, rows.length);
});

test('row shape matches placeMapCreatures (pixel centre, carried stats)', () => {
  const rows = placeCreaturePacks(boundedWorld(), [{ size: 1 }], [CREATURES[0]], 3);
  assert.equal(rows.length, 1);
  const c = rows[0];
  assert.equal((c.x - 50) % 100, 0);
  assert.equal((c.y - 50) % 100, 0);
  assert.equal(c.facing, 'S');
  assert.equal(c.type, 'goblin');
  assert.equal(c.hp, 12);
  assert.equal(c.defense, 1);
  assert.deepEqual(c.resistances, {});
});

test('deterministic: same seed => identical packs', () => {
  const a = placeCreaturePacks(boundedWorld(), [{ size: 6 }], CREATURES, 555);
  const b = placeCreaturePacks(boundedWorld(), [{ size: 6 }], CREATURES, 555);
  assert.deepEqual(a, b);
});

test('different seed => different packs (very likely)', () => {
  const a = placeCreaturePacks(boundedWorld(), [{ size: 6 }], CREATURES, 1);
  const b = placeCreaturePacks(boundedWorld(), [{ size: 6 }], CREATURES, 2);
  assert.notDeepEqual(a, b);
});

// Packs must not stack on top of the scattered creatures drawn from the same
// seed. Salting the pack stream is what prevents it; a shared stream would
// make these two sets start from identical draws.
test('packs do not reuse the scatter stream draws', () => {
  const { placeMapCreatures } = require('../src/services/mapService');
  const scatter = placeMapCreatures(boundedWorld(), 6, CREATURES, 4242);
  const packed = placeCreaturePacks(boundedWorld(), [{ size: 6 }], CREATURES, 4242);
  assert.equal(scatter.length, 6);
  assert.equal(packed.length, 6);
  assert.notEqual(`${scatter[0].x},${scatter[0].y}`, `${packed[0].x},${packed[0].y}`);
});

test('returns [] for an unbounded world', () => {
  const rows = placeCreaturePacks(
    { seed: 1, chunkSize: 64, tileTypes: TILE_TYPES }, [{ size: 5 }], CREATURES, 1);
  assert.deepEqual(rows, []);
});

test('returns [] with no packs or no allowed types', () => {
  assert.deepEqual(placeCreaturePacks(boundedWorld(), [], CREATURES, 1), []);
  assert.deepEqual(placeCreaturePacks(boundedWorld(), [{ size: 5 }], [], 1), []);
});
