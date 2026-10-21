const test = require('node:test');
const assert = require('node:assert');
const { STARTER_BIOMES } = require('../seeds/data/biomes.js');
const { DEFAULT_TILE_TYPES } = require('../seeds/data/tileTypes.js');
const { NEW_DECORATIONS, SIZE_FIXES } = require('../seeds/data/decorationTypes.js');
const { styleEntityPrompt } = require('../seeds/data/spritePrompt.js');
const {
  SCENERY_TYPES, SPAWN_TILE_ADDITIONS, BIOME_SCENERY, EXISTING_BLOCK_RADIUS,
} = require('../seeds/data/sceneryCatalog.js');

const EXISTING = new Set([...Object.keys(SIZE_FIXES), ...NEW_DECORATIONS.map((d) => d.name)]);
const TILES = new Map(DEFAULT_TILE_TYPES.map((t) => [t.name, t]));
const byName = new Map(SCENERY_TYPES.map((t) => [t.name, t]));
const walkableFloors = (b) => b.terrain_tiles.filter((t) => TILES.get(t)?.walkable);

// Effective spawn floors of any decoration after the rollout.
function spawnTiles(name) {
  if (byName.has(name)) return byName.get(name).spawn_tiles;
  const base = [...Object.values([...NEW_DECORATIONS, { name: 'Tree', spawn_tiles: ['earth', 'grass', 'leafs', 'dirt'] },
    { name: 'Stone', spawn_tiles: ['earth', 'rocks', 'sand'] }, { name: 'IceRock', spawn_tiles: ['snow', 'ice'] }]
    .find((d) => d.name === name)?.spawn_tiles || [])];
  return [...base, ...(SPAWN_TILE_ADDITIONS[name] || [])];
}
const isFeature = (name) => (byName.get(name)?.scenery_layer ?? 'feature') === 'feature';
const isCover = (name) => byName.get(name)?.scenery_layer === 'cover';

test('catalogue has the ~138 types of the spec', () => {
  assert.equal(SCENERY_TYPES.length, 138);
  assert.equal(SCENERY_TYPES.filter((t) => !t.walkable).length, 22);
});

test('every SCENERY_TYPES name is unique and not an existing decoration name', () => {
  assert.equal(byName.size, SCENERY_TYPES.length, 'duplicate scenery names');
  for (const t of SCENERY_TYPES) assert.ok(!EXISTING.has(t.name), `${t.name} clashes with an existing decoration`);
});

test('cover types are walkable with block_radius 0', () => {
  const covers = SCENERY_TYPES.filter((t) => t.scenery_layer === 'cover');
  assert.ok(covers.length > 50);
  for (const t of covers) {
    assert.equal(t.walkable, true, t.name);
    assert.equal(t.block_radius, 0, t.name);
    assert.ok(t.display_width >= 16 && t.display_width <= 32 && t.display_height >= 14 && t.display_height <= 32, `${t.name} cover size`);
  }
});

test('blocking features have 1 <= block_radius <= 20 and walkable ones have 0', () => {
  for (const t of SCENERY_TYPES) {
    if (t.walkable) assert.equal(t.block_radius, 0, t.name);
    else {
      assert.equal(t.scenery_layer, 'feature', `${t.name} blocks but is cover`);
      assert.ok(Number.isInteger(t.block_radius) && t.block_radius >= 1 && t.block_radius <= 20, `${t.name} radius ${t.block_radius}`);
    }
  }
  for (const [n, r] of Object.entries(EXISTING_BLOCK_RADIUS)) assert.ok(EXISTING.has(n) && r >= 1 && r <= 20, n);
});

test('every type has well-formed columns', () => {
  for (const t of SCENERY_TYPES) {
    assert.ok(['feature', 'cover'].includes(t.scenery_layer), t.name);
    assert.ok(Number.isInteger(t.max_per_tile) && t.max_per_tile >= 1, t.name);
    assert.ok(t.chance > 0 && t.chance <= 1, t.name);
    assert.ok(t.display_width > 0 && t.display_height > 0, t.name);
    assert.match(t.color, /^#[0-9a-f]{6}$/i, t.name);
  }
});

test('every biome has a BIOME_SCENERY entry with sane densities', () => {
  assert.equal(STARTER_BIOMES.length, 32);
  assert.deepEqual(Object.keys(BIOME_SCENERY).sort(), STARTER_BIOMES.map((b) => b.name).sort());
  for (const [name, s] of Object.entries(BIOME_SCENERY)) {
    assert.ok(s.cover_density >= 0 && s.cover_density <= 3, `${name} cover_density`);
    assert.ok(s.feature_density === null || (s.feature_density >= 0 && s.feature_density <= 1), `${name} feature_density`);
    for (const n of s.add) assert.ok(byName.has(n), `${name} adds unknown ${n}`);
  }
});

test("biomes.js flora is the end state: it contains every biome's added scenery, once", () => {
  for (const b of STARTER_BIOMES) {
    assert.equal(new Set(b.flora_types).size, b.flora_types.length, `${b.name} duplicate flora`);
    for (const n of BIOME_SCENERY[b.name].add) assert.ok(b.flora_types.includes(n), `${b.name} missing ${n}`);
    for (const n of b.flora_types) assert.ok(EXISTING.has(n) || byName.has(n), `${b.name} dangling ${n}`);
    assert.equal(b.cover_density, BIOME_SCENERY[b.name].cover_density, `${b.name} cover_density in biomes.js`);
    assert.equal(b.feature_density ?? null, BIOME_SCENERY[b.name].feature_density, `${b.name} feature_density in biomes.js`);
  }
});

test('every biome gets at least one cover type that spawns on one of its floors', () => {
  for (const b of STARTER_BIOMES) {
    const floors = new Set(walkableFloors(b));
    const hit = b.flora_types.filter((n) => isCover(n) && spawnTiles(n).some((t) => floors.has(t)));
    assert.ok(hit.length >= 1, `${b.name} has no cover that can spawn`);
  }
});

test('every biome with a walkable floor gets at least one feature type that spawns on it', () => {
  for (const b of STARTER_BIOMES) {
    const floors = new Set(walkableFloors(b));
    assert.ok(floors.size > 0, `${b.name} has no walkable floor`);
    const hit = b.flora_types.filter((n) => isFeature(n) && spawnTiles(n).some((t) => floors.has(t)));
    assert.ok(hit.length >= 1, `${b.name} has no feature that can spawn`);
  }
});

test('every spawn_tiles entry names a real, walkable tile type', () => {
  const lists = [...SCENERY_TYPES.map((t) => [t.name, t.spawn_tiles]), ...Object.entries(SPAWN_TILE_ADDITIONS)];
  for (const [name, tiles] of lists) {
    assert.ok(tiles.length > 0, `${name} has no spawn tiles`);
    for (const t of tiles) {
      assert.ok(TILES.has(t), `${name}: unknown tile ${t}`);
      assert.ok(TILES.get(t).walkable, `${name}: unwalkable tile ${t}`);
    }
  }
  for (const n of Object.keys(SPAWN_TILE_ADDITIONS)) assert.ok(EXISTING.has(n), `${n} is not an existing decoration`);
});

test('every type has a non-empty prompt built with styleEntityPrompt', () => {
  for (const t of SCENERY_TYPES) {
    assert.ok(t.prompt.length > 0, t.name);
    assert.equal(styleEntityPrompt(t.prompt), t.prompt, `${t.name} prompt not styled`);
    assert.match(t.prompt, /^pixel art, .*single object, solid transparent background$/, t.name);
    if (t.scenery_layer === 'cover') assert.match(t.prompt, /small and flat/, `${t.name} cover prompt`);
  }
});
