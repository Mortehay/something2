// SOMET-644. Byte parity of the JS world-spec generator
// (backend/src/services/worldGen/worldGen.js) with the GPU box's Python one
// (backend/tools/world_gen_ref/world_gen.py).
//
// Every expected value comes from the committed golden fixtures written by
// backend/tools/world_gen_ref/make_fixtures.py from the vendored reference
// (their own integrity is world_gen_ref_integrity.test.js). No python, no DB.
//
// report() and its private helper _depth_of are Task 4 and are not covered here.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const W = require('../src/services/worldGen/worldGen');
const { pyFloat, dumpsPy } = require('../src/services/worldGen/pyCompat');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'world_gen');
const readFixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));

const HELPERS = readFixture('helpers.json').helpers;
const CONSTANTS = readFixture('constants.json').constants;
const PLAN_CASES = readFixture('plan_cases.json').cases;
const BOX = readFixture('box_parity.json').case;

// Python helper name -> [JS function, does it return a Python float].
// A float result is also checked as text against the fixture's result_json,
// because JSON.parse turns 4.0 into 4 and a deep-equal alone cannot see it.
const HELPER_FNS = {
  per_screen: [W.perScreen, true],
  resolve_density: [W.resolveDensity, false],
  choose_density: [W.chooseDensity, false],
  _seed_for: [W.seedFor, false],
  _spiral: [W.spiral, false],
  flora_types: [W.floraTypes, false],
  enrich_flora: [W.enrichFlora, false],
  creature_types: [W.creatureTypes, false],
  spawnable: [W.spawnable, false],
  enrich_variety: [W.enrichVariety, false],
  families_for: [W.familiesFor, false],
  bestiary_types: [W.bestiaryTypes, false],
  leader_count: [W.leaderCount, false],
  biome_multiplier: [W.biomeMultiplier, true],
  socket_kib_s: [W.socketKibS, true],
  to_px: [W.toPx, false],
  is_tile_centre: [W.isTileCentre, false],
  _slug: [W.slug, false],
  _title: [W.title, false],
};
// Not plain fn(args) -> result rows; tested on their own below.
const SPECIAL = new Set(['check_units', 'plan_region_errors']);
// report()'s private helper: Task 4.
const DEFERRED = new Set(['_depth_of']);

test('every helper in helpers.json is covered (none silently skipped)', () => {
  for (const key of Object.keys(HELPERS)) {
    assert.ok(key in HELPER_FNS || SPECIAL.has(key) || DEFERRED.has(key), `no test for helper ${key}`);
  }
  for (const [key, [fn]] of Object.entries(HELPER_FNS)) {
    assert.equal(typeof fn, 'function', `worldGen does not export the port of ${key}`);
  }
});

for (const [key, [fn, returnsFloat]] of Object.entries(HELPER_FNS)) {
  test(`${key}: every fixture row matches`, () => {
    const rows = HELPERS[key];
    assert.ok(rows.length > 0);
    for (const row of rows) {
      const args = [...row.args];
      if (row.kwargs) {
        assert.deepEqual(Object.keys(row.kwargs), ['limit'], `${key}: unexpected kwargs`);
        args.push(row.kwargs.limit);
      }
      const where = `${key}(${JSON.stringify(row.args)}${row.kwargs ? `, ${JSON.stringify(row.kwargs)}` : ''})`;
      const got = fn(...args);
      assert.deepEqual(got, row.result, where);
      if (row.result_json !== undefined) {
        assert.ok(returnsFloat, `${where}: fixture pins a float but the helper is not marked float`);
        assert.equal(dumpsPy(pyFloat(got)), row.result_json, `${where} (float text)`);
      } else {
        assert.ok(!returnsFloat, `${where}: float helper row has no result_json`);
      }
    }
  });
}

test('check_units: every hand-built world gives the same problems, verbatim', () => {
  assert.equal(HELPERS.check_units.length, 10);
  for (const row of HELPERS.check_units) {
    assert.deepEqual(W.checkUnits(structuredClone(row.world)), row.result, row.id);
  }
});

test('plan_region refuses fewer than one world with the same error', () => {
  for (const row of HELPERS.plan_region_errors) {
    assert.throws(() => W.planRegion(row.args), (err) => {
      assert.equal(err.name, row.error);
      assert.equal(err.message, row.message);
      return true;
    }, JSON.stringify(row.args));
  }
});

test(`planRegion: all ${PLAN_CASES.length} fixture cases are byte-equal through toJson`, () => {
  assert.equal(PLAN_CASES.length, 34);
  const failed = [];
  for (const c of PLAN_CASES) {
    const text = W.toJson(W.planRegion(structuredClone(c.args)));
    if (text !== c.to_json) failed.push(c.id);
  }
  assert.deepEqual(failed, [], `cases not byte-equal: ${failed.join(', ')}`);
});

for (const c of PLAN_CASES) {
  test(`planRegion case ${c.id}`, () => {
    const spec = W.planRegion(structuredClone(c.args));
    // Structural first, so a failure shows a readable diff, then the bytes.
    assert.deepEqual(JSON.parse(W.toJson(spec)), JSON.parse(c.to_json));
    assert.equal(W.toJson(spec), c.to_json);
  });
}

test('the live box parity-somet644 spec is reproduced byte for byte', () => {
  const spec = W.planRegion(structuredClone(BOX.plan_region_args));
  assert.deepEqual(JSON.parse(W.toJson(spec)), BOX.box_spec);
  assert.equal(W.toJson(spec), BOX.to_json);
});

test('planRegion does not mutate its arguments', () => {
  const args = {
    name: 'Deep Plan', world_count: 5, target_per_screen: 8.1,
    biome_plan: [['Meadow'], ['Catacombs', 'Deepvault'], ['Infernal Gate'], ['The Maw', 'Mire'], ['Abyssal Rift']],
    entry_biomes: ['Arid Dunes'],
  };
  const before = structuredClone(args);
  W.planRegion(args);
  assert.deepEqual(args, before);
});

test('constants equal constants.json', () => {
  const c = CONSTANTS;
  for (const name of [
    'DENSITY_TIERS', 'DENSITY_ORDER', 'TILES_PER_SCREEN', 'MAX_WORLD_CREATURES',
    'BYTES_PER_CREATURE_PER_SEC', 'NEIGHBOURHOOD_CHUNKS', 'SOCKET_WARN_KIB_S',
    'THIN_VARIETY_BELOW', 'THIN_FLORA_BELOW', 'EMPTY_BELOW_PER_SCREEN', 'CROWDED_ABOVE_PER_SCREEN',
    'SURFACE_BAND', 'MAX_LEADER_ROLES_PER_WORLD', 'TILE_PX', 'SAFE_ROAD_RADIUS', 'EDGES',
    'BIOMES', 'BIOME_FAMILIES', 'SURFACE', 'DEEP', 'ROLES',
  ]) {
    assert.deepEqual(W[name], c[name], name);
  }
  assert.deepEqual([...W.LEADER_ROLES].sort(), c.LEADER_ROLES);
  assert.deepEqual([...W.FLORA_OPTIONAL].sort(), c.FLORA_OPTIONAL);
  // The float-typed tables, as Python prints them (0.0, 1.0 survive).
  const tiers = new Map(Object.entries(W.DENSITY_TIERS).map(([k, v]) => [k, pyFloat(v)]));
  assert.equal(dumpsPy(tiers), c.DENSITY_TIERS_json);
  const biomes = new Map(Object.entries(W.BIOMES).map(([k, b]) => [k, { ...b, creature_density: pyFloat(b.creature_density) }]));
  assert.equal(dumpsPy(biomes), c.BIOMES_json);
});

test('the bundled bestiary_p4.json is byte-identical to the vendored reference', () => {
  const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const ours = path.join(__dirname, '..', 'src', 'services', 'worldGen', 'bestiary_p4.json');
  const ref = path.join(__dirname, '..', 'tools', 'world_gen_ref', 'bestiary_p4.json');
  const pinned = '3c5e3c5c5b55e8fc0f0260b506eb9c004f3071fa42e9abb794e7cd64f094868a';
  assert.equal(sha(ref), pinned);
  assert.equal(sha(ours), pinned);
});
