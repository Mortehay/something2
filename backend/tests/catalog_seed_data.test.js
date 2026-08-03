const test = require('node:test');
const assert = require('node:assert');
const { DEFAULT_TILE_TYPES } = require('../seeds/data/tileTypes.js');
const { STARTER_BIOMES } = require('../seeds/data/biomes.js');
const { NEW_DECORATIONS } = require('../seeds/data/decorationTypes.js');
const { HOSTILE_CREATURES, CREATURE_DROPS } = require('../seeds/data/entityTypes.js');

// Tile names inserted by the three migrations that seed tile_types:
//   1714440002000_create_tile_types.js  (the defaultTileTypes object)
//   1714440027000_bounded_worlds.js     (map_wall, map_doorway)
//   1714440029000_villages_and_binds.js (wooden_wall, village_gate)
// The seeder upserts by name and therefore becomes authoritative on a fresh
// database. If it is missing a tile the migrations create, a `make
// seed-catalogs` run would leave a gap that only shows up as an invisible
// fallback colour in a rendered world -- so pin the superset relationship.
const MIGRATION_TILE_NAMES = [
  'grass', 'highgrass', 'leafs', 'sand', 'rocks', 'earth', 'dirt',
  'snow', 'ice', 'swamp', 'water',
  'map_wall', 'map_doorway',
  'wooden_wall', 'village_gate',
];

test('the tile seed file is a superset of every migration-seeded tile', () => {
  const seeded = new Set(DEFAULT_TILE_TYPES.map((t) => t.name));
  const missing = MIGRATION_TILE_NAMES.filter((n) => !seeded.has(n));
  assert.deepEqual(missing, [], `tile seed file is missing: ${missing.join(', ')}`);
});

test('every tile seed row is fully formed', () => {
  assert.ok(DEFAULT_TILE_TYPES.length > 0, 'no tiles — this test would assert nothing');
  for (const t of DEFAULT_TILE_TYPES) {
    assert.ok(t.name, 'tile has no name');
    // 6-digit RRGGBB, or 8-digit RRGGBBAA (highgrass/leafs/dirt carry a
    // trailing alpha channel in the original migration — verbatim, not a typo).
    assert.match(t.color, /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/, `${t.name} colour is not a valid hex string`);
    assert.equal(typeof t.walkable, 'boolean', `${t.name} walkable must be boolean`);
    assert.equal(typeof t.speed, 'number', `${t.name} speed must be a number`);
    assert.ok(Array.isArray(t.valid_neighbors), `${t.name} valid_neighbors must be an array`);
  }
});

test('the moved catalog arrays are still intact', () => {
  assert.equal(STARTER_BIOMES.length, 5);
  assert.ok(NEW_DECORATIONS.length > 0);
});

// The three creatures migration 1714440022000_elements.js inserts. The seed
// file must stay a superset: it is applied to databases the migration has
// already run on, so a creature it omits is one `make seed-catalogs` cannot
// restore after a hand-deletion in the admin UI.
const MIGRATION_CREATURE_NAMES = ['Slime', 'Skeleton', 'Bat'];

test('the creature seed file is a superset of every migration-seeded creature', () => {
  const seeded = new Set(HOSTILE_CREATURES.map((c) => c.name));
  const missing = MIGRATION_CREATURE_NAMES.filter((n) => !seeded.has(n));
  assert.deepEqual(missing, [], `creature seed file is missing: ${missing.join(', ')}`);
});

// The regression this whole file pair exists to prevent. Wolf is the one
// creature no migration creates, so it is the one that silently vanished
// when the dev Postgres volume was rebuilt -- while two biomes went on
// referencing it. If it leaves the seed file again, that dangling reference
// comes straight back.
test('Wolf is present — no migration seeds it, so only this file can', () => {
  const wolf = HOSTILE_CREATURES.find((c) => c.name === 'Wolf');
  assert.ok(wolf, 'Wolf is missing from the creature seed file');
  // hp drives the gold formula and the drop-worthiness of the kill; 12 is the
  // value recovered from docs/audits/2026-07-24/browser-run.md:244.
  assert.equal(wolf.hp, 12);
  assert.equal(wolf.max_hp, wolf.hp, 'max_hp must match hp (elements.js:37 backfilled it)');
  assert.deepEqual(wolf.resistances, {}, 'Wolf is the neutral baseline: no resistances');
});

test('every creature seed row is fully formed', () => {
  assert.ok(HOSTILE_CREATURES.length > 0, 'no creatures — this test would assert nothing');
  for (const c of HOSTILE_CREATURES) {
    assert.ok(c.name, 'creature has no name');
    assert.match(c.color, /^#[0-9a-fA-F]{6}$/, `${c.name} colour is not a valid hex string`);
    assert.ok(Number.isInteger(c.hp) && c.hp > 0, `${c.name} needs a positive integer hp`);
    assert.equal(c.max_hp, c.hp, `${c.name} max_hp must equal hp`);
    assert.ok(c.prompt && c.prompt.trim().length > 0, `${c.name} needs a sprite-gen prompt`);
    assert.equal(typeof c.defense, 'number', `${c.name} defense must be a number`);
    // Resistance values outside [0,1] are a silent balance bug: the mitigation
    // maths treats them as a fraction of damage removed, so 1.5 heals the
    // creature and a negative value amplifies the hit.
    for (const [el, v] of Object.entries(c.resistances)) {
      assert.ok(v > 0 && v <= 1, `${c.name} resistance ${el}=${v} must be in (0, 1]`);
    }
    // gold_max >= gold_min or the [min,max] roll inverts and yields nothing.
    assert.ok(c.gold_max >= c.gold_min, `${c.name} gold_max must be >= gold_min`);
    assert.ok(c.gold_min >= 1, `${c.name} is hostile, so it must carry at least 1 gold`);
  }
});

// Village Guard is is_creature = true in the database but must never be in
// this array: seedCatalogs inserts every row here as a wild-spawnable
// hostile, and a guard rolled into the wild-spawn pool has no home_x/home_y,
// so withinLeash treats it as unconstrained — a 300-hp world-roaming
// creature-hunter. src/authority/creatures.js filters guards out of the
// spawn pool by faction; this keeps them from entering by the seed door.
test('the guard is not in the wild-spawn creature catalog', () => {
  assert.ok(
    !HOSTILE_CREATURES.some((c) => c.name === 'Village Guard'),
    'Village Guard is structural — it must not be seeded as a huntable creature',
  );
});

test('every drop rule names a creature in the catalog and a legal chance', () => {
  const names = new Set(HOSTILE_CREATURES.map((c) => c.name));
  for (const d of CREATURE_DROPS) {
    assert.ok(names.has(d.creature), `drop rule references unknown creature ${d.creature}`);
    assert.ok(d.item && d.item.trim().length > 0, `${d.creature} drop rule has no item`);
    // Mirrors creature_drops_chance_check / creature_drops_qty_check in
    // 1714440018000_create_loot.js — a violation here fails at INSERT time
    // mid-seed, after earlier catalogs have already been written.
    assert.ok(d.chance > 0 && d.chance <= 1, `${d.creature} drop chance ${d.chance} must be in (0, 1]`);
    assert.ok(d.min_qty >= 1 && d.max_qty >= d.min_qty, `${d.creature} drop quantities are inverted`);
  }
});
