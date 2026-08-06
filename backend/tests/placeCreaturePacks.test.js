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

// --- levels and stat scaling ----------------------------------------------
//
// SOMET-246 final review, finding 5. placeCreaturePacks carries its own copy
// of the rollCreatureLevel/scaleCreature block, but every fixture above uses
// boundedWorld(), which sets no levelMin/levelMax -- so rollCreatureLevel
// returns 1 for all of them and scaleCreature is a no-op. Hardcoding
// `level: 1` inside emit() would have kept this entire file green while every
// pack member in every world shipped unscaled. These four tests are the ones
// that go red for that. Fixture shape follows creature_spawn_levels.test.js,
// which covers the same block on the scatter side.

test('pack members roll levels inside the world band, not a hardcoded 1', () => {
  const world = boundedWorld({ levelMin: 3, levelMax: 5 });
  const rows = placeCreaturePacks(world, [{ size: 8 }], CREATURES, 4242);
  assert.equal(rows.length, 8, 'fixture placed a short pack — the level assertions would be weak');
  for (const c of rows) {
    assert.ok(c.level >= 3 && c.level <= 5, `level ${c.level} escaped the band [3,5]`);
  }
  // A pinned `level: 1` fails the band check above; a pinned `level: 3` (the
  // band floor) would not, so require the roll to actually move within a pack.
  assert.ok(new Set(rows.map((c) => c.level)).size > 1,
    'every member rolled the same level — the level draw is not varying per member');
});

test('pack members scale hp/damage/defense from their level', () => {
  // Band pinned to a single value so every member's stats have one exact
  // hand-computed answer. A pack is single-type, so only one of the two
  // expected stat rows below is exercised per run -- assert against whichever
  // type the pack actually rolled.
  const world = boundedWorld({ levelMin: 4, levelMax: 4 });
  const rows = placeCreaturePacks(world, [{ size: 6 }], CREATURES, 4242);
  assert.equal(rows.length, 6, 'fixture placed a short pack — the scaling assertions would be weak');
  for (const c of rows) {
    assert.equal(c.level, 4);
    // Level 4 = 3 steps. goblin: round(12 * (1 + 0.15*3)) = round(17.4) = 17.
    //                    wolf:   round(8 * 1.45)          = round(11.6) = 12.
    assert.equal(c.hp, c.type === 'goblin' ? 17 : 12);
    // Damage from the CREATURE_BASE_DAMAGE baseline of 5: round2(5 * 1.3) = 6.5.
    assert.equal(c.damage, 6.5);
    // goblin base defense 1: round2(1 + 0.5*3) = 2.5. wolf base 0: 1.5.
    assert.equal(c.defense, c.type === 'goblin' ? 2.5 : 1.5);
  }
});

test('an unscaled pack member is distinguishable from a scaled one', () => {
  // The direct counterfactual for "scaleCreature was never called": at level 1
  // the same fixture must produce the entity type's raw hp, and at a high
  // level it must not. Without this, a pack function that dropped scaleCreature
  // entirely would still satisfy the band check above.
  const flat = placeCreaturePacks(boundedWorld(), [{ size: 4 }], [CREATURES[0]], 4242);
  const high = placeCreaturePacks(
    boundedWorld({ levelMin: 10, levelMax: 10 }), [{ size: 4 }], [CREATURES[0]], 4242);
  assert.equal(flat.length, 4);
  assert.equal(high.length, 4);
  assert.equal(flat[0].hp, 12, 'an unbanded world must carry the goblin\'s base hp through');
  // Level 10 = 9 steps: round(12 * (1 + 0.15*9)) = round(28.2) = 28.
  assert.equal(high[0].hp, 28);
  assert.equal(high[0].defense, 5.5);   // round2(1 + 0.5*9)
});

test('the pack level roll is deterministic for a fixed seed', () => {
  const world = boundedWorld({ levelMin: 2, levelMax: 9 });
  const a = placeCreaturePacks(world, [{ size: 6 }], CREATURES, 8080);
  const b = placeCreaturePacks(world, [{ size: 6 }], CREATURES, 8080);
  assert.equal(a.length, 6);
  assert.deepEqual(a.map((c) => [c.type, c.x, c.y, c.level, c.hp]),
                   b.map((c) => [c.type, c.x, c.y, c.level, c.hp]));
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
