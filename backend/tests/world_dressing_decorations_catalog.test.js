// SOMET-772 world dressing: invariants of the 60-type decoration catalog and
// its wiring into the biomes. Pure data checks -- no database.
const test = require('node:test');
const assert = require('node:assert');
const { WORLD_DRESSING_DECORATIONS: WD, NEW_DECORATIONS, SIZE_FIXES } = require('../seeds/data/decorationTypes.js');
const { STARTER_BIOMES } = require('../seeds/data/biomes.js');
const { DEFAULT_TILE_TYPES } = require('../seeds/data/tileTypes.js');

const TILES = new Set(DEFAULT_TILE_TYPES.map((t) => t.name));
const BIOMES = new Map(STARTER_BIOMES.map((b) => [b.name, b]));
const EXISTING = new Set([...Object.keys(SIZE_FIXES), ...NEW_DECORATIONS.map((d) => d.name)]);

test('the catalog has exactly the 60 owner-approved types, uniquely named', () => {
  assert.equal(WD.length, 60);
  const names = WD.map((d) => d.name);
  assert.equal(new Set(names).size, 60, 'duplicate name');
  for (const n of names) assert.ok(!EXISTING.has(n), `${n} collides with an existing decoration`);
});

test('every entry is a well-formed static decoration', () => {
  for (const d of WD) {
    assert.equal(d.is_creature, false, d.name);
    assert.equal(d.render_mode, 'static', d.name);
    assert.ok(['main', 'ground'].includes(d.deco_layer), `${d.name} layer`);
    assert.equal(typeof d.walkable, 'boolean', d.name);
    assert.ok(d.display_width > 0 && d.display_height > 0, `${d.name} size`);
    assert.ok(d.chance > 0, `${d.name} weight`);
    assert.match(d.color, /^#[0-9a-f]{6}$/i, `${d.name} colour`);
    assert.ok(typeof d.prompt === 'string' && d.prompt.trim().length > 20, `${d.name} prompt`);
  }
  assert.equal(new Set(WD.map((d) => d.prompt)).size, 60, 'two types share a prompt -- variants must differ');
});

test('ground cover never blocks (the database refuses it too)', () => {
  for (const d of WD.filter((x) => x.deco_layer === 'ground')) assert.equal(d.walkable, true, d.name);
});

test('spawn tiles and biomes name real catalog entries', () => {
  for (const d of WD) {
    assert.ok(d.spawn_tiles.length > 0, `${d.name} has no spawn tiles`);
    for (const t of d.spawn_tiles) assert.ok(TILES.has(t), `${d.name}: unknown tile ${t}`);
    assert.ok(d.biomes.length > 0, `${d.name} joins no biome`);
    for (const b of d.biomes) assert.ok(BIOMES.has(b), `${d.name}: unknown biome ${b}`);
  }
});

test('every type is merged into the flora list of each biome it names', () => {
  for (const d of WD) {
    for (const b of d.biomes) assert.ok(BIOMES.get(b).flora_types.includes(d.name), `${b} missing ${d.name}`);
  }
});

test('the merge keeps each biome\'s authored flora first and adds no duplicates', () => {
  const meadow = BIOMES.get('Meadow');
  assert.deepEqual(meadow.flora_types.slice(0, 4), ['bush', 'rose_bush', 'Tree', 'Stone']);
  for (const b of STARTER_BIOMES) assert.equal(new Set(b.flora_types).size, b.flora_types.length, `${b.name} dup flora`);
});

test('no biome with terrain is left barren: something new can be placed in every one', () => {
  const barren = [];
  for (const b of STARTER_BIOMES) {
    const terrain = new Set(b.terrain_tiles);
    const placeable = WD.some((d) => d.biomes.includes(b.name) && d.spawn_tiles.some((t) => terrain.has(t)));
    if (!placeable) barren.push(b.name);
  }
  assert.deepEqual(barren, []);
});
