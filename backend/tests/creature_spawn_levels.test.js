const test = require('node:test');
const assert = require('node:assert');
const { spawnChunkCreatures, placeMapCreatures } = require('../src/services/mapService.js');

const TYPES = [
  { name: 'Wolf', hp: 12, defense: 0, resistances: {} },
  { name: 'Bat', hp: 8, defense: 0, resistances: { lightning: 0.5 } },
];

// tileTypes must be non-empty: worldConfig() throws on an empty map (see
// worldGen.test.js:62), so a bare `{}` here would fail before the level roll
// is ever exercised. Every other spawnChunkCreatures test in the suite uses
// the same minimal `{ grass: {} }` fixture.
const UNBOUNDED = { seed: 12345, chunkSize: 16, tileTypes: { grass: {} } };

test('unbounded spawn assigns every creature a level inside the band', () => {
  const world = { ...UNBOUNDED, levelMin: 4, levelMax: 7 };
  const out = spawnChunkCreatures(world, 0, 0, TYPES);
  assert.ok(out.length > 0, 'fixture produced no creatures — this test would assert nothing');
  for (const c of out) {
    assert.ok(Number.isInteger(c.level), `${c.type} level must be an integer`);
    assert.ok(c.level >= 4 && c.level <= 7, `level ${c.level} escaped the band [4,7]`);
  }
});

test('unbounded spawn is deterministic: the same chunk re-rolls identical levels', () => {
  // world_chunks is CACHED. A creature whose level changed on chunk reload
  // would harden or soften as a player walked away and came back.
  const world = { ...UNBOUNDED, levelMin: 2, levelMax: 9 };
  const a = spawnChunkCreatures(world, 3, 5, TYPES);
  const b = spawnChunkCreatures(world, 3, 5, TYPES);
  assert.deepEqual(a.map((c) => [c.type, c.x, c.y, c.level]),
                   b.map((c) => [c.type, c.x, c.y, c.level]));
});

test('the level roll is independent of the type roll', () => {
  // If level reused the type hash, every Wolf in a chunk would share one level
  // and the band would collapse to as many distinct values as there are types.
  const world = { ...UNBOUNDED, levelMin: 1, levelMax: 20 };
  const out = spawnChunkCreatures(world, 0, 0, TYPES);
  const byType = new Map();
  for (const c of out) {
    if (!byType.has(c.type)) byType.set(c.type, new Set());
    byType.get(c.type).add(c.level);
  }
  const widest = Math.max(...[...byType.values()].map((s) => s.size));
  assert.ok(widest > 1,
    'every creature of a type got the same level — the level roll is reusing the type hash');
});

test('unbounded spawn scales hp with level and leaves resistances alone', () => {
  const world = { ...UNBOUNDED, levelMin: 6, levelMax: 6 };
  const out = spawnChunkCreatures(world, 0, 0, TYPES);
  assert.ok(out.length > 0);
  for (const c of out) {
    assert.equal(c.level, 6);
    // Level 6 = 5 steps. Wolf: round(12 * (1 + 0.15*5)) = round(21) = 21.
    //                    Bat: round(8 * 1.75) = 14.
    assert.equal(c.hp, c.type === 'Wolf' ? 21 : 14);
    // Damage from the CREATURE_DAMAGE baseline of 5: round2(5 * 1.5) = 7.5
    assert.equal(c.damage, 7.5);
  }
  const bat = out.find((c) => c.type === 'Bat');
  if (bat) assert.deepEqual(bat.resistances, { lightning: 0.5 }, 'resistances must pass through unscaled');
});

test('a world with no band spawns everything at level 1 with unscaled hp', () => {
  const out = spawnChunkCreatures({ ...UNBOUNDED }, 0, 0, TYPES);
  assert.ok(out.length > 0);
  for (const c of out) {
    assert.equal(c.level, 1);
    assert.equal(c.hp, c.type === 'Wolf' ? 12 : 8);
    assert.equal(c.damage, 5);
  }
});

const BOUNDED = {
  seed: 999, chunkSize: 16, width: 40, height: 40,
  tileTypes: { grass: { walkable: true } },
};

test('bounded placement assigns levels inside the band and is deterministic', () => {
  const world = { ...BOUNDED, levelMin: 3, levelMax: 5 };
  const a = placeMapCreatures(world, 8, TYPES, 4242);
  const b = placeMapCreatures(world, 8, TYPES, 4242);
  assert.ok(a.length > 0, 'fixture placed no creatures — this test would assert nothing');
  assert.deepEqual(a.map((c) => [c.type, c.x, c.y, c.level]),
                   b.map((c) => [c.type, c.x, c.y, c.level]));
  for (const c of a) {
    assert.ok(c.level >= 3 && c.level <= 5, `level ${c.level} escaped the band [3,5]`);
    assert.ok(Number.isFinite(c.damage) && c.damage > 0, 'damage must be carried');
  }
});
