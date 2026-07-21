const test = require('node:test');
const assert = require('node:assert');
const { placeMapCreatures } = require('../src/services/mapService');

// Minimal walkable tile world: two genuine biomes (grass walkable, water not)
// plus the seeded bound tiles (map_wall/map_doorway are stamped on the ring by
// stampBounds, not sampled as interior biomes, so they are intentionally left
// out of tileTypes here -- keeping the biome set small makes "exactly count"
// robust under rejection sampling).
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

test('places exactly `count` creatures when interior is walkable', () => {
  const rows = placeMapCreatures(boundedWorld(), 10, CREATURES, 123);
  assert.equal(rows.length, 10);
});

test('every creature lands strictly inside the wall ring (never on the ring or outside)', () => {
  const rows = placeMapCreatures(boundedWorld(), 25, CREATURES, 7);
  for (const c of rows) {
    const col = Math.floor(c.x / 100);
    const row = Math.floor(c.y / 100);
    assert.ok(row >= 1 && row <= 22, `row ${row} inside 1..22`);
    assert.ok(col >= 1 && col <= 22, `col ${col} inside 1..22`);
  }
});

test('every creature stands on a walkable, non-wall, non-doorway tile', () => {
  const { generateRegion } = require('../src/services/mapService');
  const world = boundedWorld();
  const rows = placeMapCreatures(world, 25, CREATURES, 99);
  for (const c of rows) {
    const col = Math.floor(c.x / 100);
    const row = Math.floor(c.y / 100);
    const name = generateRegion(world, row, col, 1, 1)[0][0];
    assert.notEqual(name, 'map_wall');
    assert.notEqual(name, 'map_doorway');
    assert.notEqual(TILE_TYPES[name].walkable, false);
  }
});

test('creature types are drawn only from allowedTypes', () => {
  const rows = placeMapCreatures(boundedWorld(), 15, CREATURES, 5);
  const allowed = new Set(['goblin', 'wolf']);
  for (const c of rows) assert.ok(allowed.has(c.type));
});

test('deterministic: same seed => identical placement', () => {
  const a = placeMapCreatures(boundedWorld(), 12, CREATURES, 555);
  const b = placeMapCreatures(boundedWorld(), 12, CREATURES, 555);
  assert.deepEqual(a, b);
});

test('different seed => different placement (very likely)', () => {
  const a = placeMapCreatures(boundedWorld(), 12, CREATURES, 1);
  const b = placeMapCreatures(boundedWorld(), 12, CREATURES, 2);
  assert.notDeepEqual(a, b);
});

test('returns [] for an unbounded world', () => {
  const rows = placeMapCreatures({ seed: 1, chunkSize: 64, tileTypes: TILE_TYPES }, 10, CREATURES, 1);
  assert.deepEqual(rows, []);
});

test('returns [] when count < 1 or allowedTypes empty', () => {
  assert.deepEqual(placeMapCreatures(boundedWorld(), 0, CREATURES, 1), []);
  assert.deepEqual(placeMapCreatures(boundedWorld(), 5, [], 1), []);
});

test('row shape matches spawnChunkCreatures (pixel center, carried stats)', () => {
  const rows = placeMapCreatures(boundedWorld(), 1, [CREATURES[0]], 3);
  const c = rows[0];
  assert.equal((c.x - 50) % 100, 0);
  assert.equal((c.y - 50) % 100, 0);
  assert.equal(c.facing, 'S');
  assert.equal(c.type, 'goblin');
  assert.equal(c.hp, 12);
  assert.equal(c.defense, 1);
  assert.deepEqual(c.resistances, {});
});
