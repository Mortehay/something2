const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { validateMapSpec } = require('../seeds/mapSpec.js');
const { STARTER_BIOMES } = require('../seeds/data/biomes.js');

const MAPS_DIR = path.join(__dirname, '..', 'seeds', 'maps');
const BIOMES = new Set(STARTER_BIOMES.map((b) => b.name));
// Corrected from the brief's ['Slime', 'Wolf', 'Skeleton', 'Bat']: Wolf is not
// seeded by any migration (it was lost in the dev-Postgres volume rebuild
// documented in progress.md and was never migration-seeded to begin with).
// The live entity_types catalog has exactly four creatures -- Slime,
// Skeleton, Bat, Village Guard -- and Village Guard is a village gate
// defender, not a huntable overworld spawn, so it is excluded here too.
const CREATURES = new Set(['Slime', 'Skeleton', 'Bat']);

const specFiles = () => fs.readdirSync(MAPS_DIR).filter((f) => f.endsWith('.map.json'));

test('all three example topologies ship', () => {
  assert.deepEqual(specFiles().sort(),
    ['hub-vale.map.json', 'loop-catacombs.map.json', 'spine-descent.map.json']);
});

test('every shipped spec validates against the live catalogs', () => {
  for (const f of specFiles()) {
    const spec = JSON.parse(fs.readFileSync(path.join(MAPS_DIR, f), 'utf8'));
    const errs = validateMapSpec(spec, { biomeNames: BIOMES, creatureTypeNames: CREATURES });
    assert.deepEqual(errs, [], `${f}: ${errs.join('; ')}`);
  }
});

test('difficulty escalates with distance from the entry', () => {
  // An adventure map whose creature counts are flat is not an adventure. This
  // asserts the shape of the content, not just its syntax.
  for (const f of specFiles()) {
    const spec = JSON.parse(fs.readFileSync(path.join(MAPS_DIR, f), 'utf8'));
    const entry = spec.worlds.find((w) => w.is_entry);
    const counts = spec.worlds.map((w) => w.creature_count);
    assert.ok(Math.max(...counts) > Math.min(...counts), `${f}: every world has the same creature_count`);
    assert.equal(entry.creature_count, Math.min(...counts),
      `${f}: the entry world should be the safest`);
  }
});

test('hub-vale has a village in its hub and at most four spokes', () => {
  const spec = JSON.parse(fs.readFileSync(path.join(MAPS_DIR, 'hub-vale.map.json'), 'utf8'));
  const hub = spec.worlds.find((w) => w.is_entry);
  assert.ok(hub.village, 'the hub is the bind point and needs a village');
  const outgoing = spec.links.filter((l) => l.from === hub.key).length;
  assert.ok(outgoing <= 4, `hub has ${outgoing} spokes; UNIQUE(from_world_id, edge) allows 4`);
});

test('loop-catacombs actually contains a cycle', () => {
  const spec = JSON.parse(fs.readFileSync(path.join(MAPS_DIR, 'loop-catacombs.map.json'), 'utf8'));
  // A connected undirected graph has a cycle iff edges >= nodes.
  assert.ok(spec.links.length >= spec.worlds.length,
    'no cycle: a loop topology needs at least as many links as worlds');
});
