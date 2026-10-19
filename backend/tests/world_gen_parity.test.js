// SOMET-644. Byte parity of the JS world-spec generator
// (backend/src/services/worldGen/worldGen.js) with the GPU box's Python one
// (backend/tools/world_gen_ref/world_gen.py).
//
// Every expected value comes from the committed golden fixtures written by
// backend/tools/world_gen_ref/make_fixtures.py from the vendored reference
// (their own integrity is world_gen_ref_integrity.test.js). No python, no DB.
//
// report() is held to Python's json.dumps(report, indent=2) TEXT (report_json),
// not just to the parsed value: it emits integer-valued floats (14.0) that a
// deep-equal cannot see. Its input specs are read with a float-preserving
// loader (loadPyJson), because JSON.parse turns 6450.0 into 6450 - which
// isTileCentre would accept where Python rejects it.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const W = require('../src/services/worldGen/worldGen');
const { pyFloat, isPyFloat, dumpsPy } = require('../src/services/worldGen/pyCompat');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'world_gen');
const readFixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));

const HELPERS = readFixture('helpers.json').helpers;
const CONSTANTS = readFixture('constants.json').constants;
const PLAN_CASES = readFixture('plan_cases.json').cases;
const BOX = readFixture('box_parity.json').case;

// json.loads with Python's int/float split kept: a number token with a
// fraction or exponent is a float and comes back as pyFloat(x) (arithmetic-
// transparent, prints as a float); every other token is a plain number (an
// int). Strings, literals and structure go through JSON.parse. Tests only:
// it exists to hand report() exactly the spec Python saw.
function loadPyJson(text) {
  let i = 0;
  const ws = () => { while (/\s/.test(text[i] ?? '')) i += 1; };
  const STRING = /"(?:[^"\\]|\\.)*"/y;
  const NUMBER = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;
  const LITERAL = /true|false|null/y;
  const match = (re) => {
    re.lastIndex = i;
    const m = re.exec(text);
    if (!m) throw new SyntaxError(`loadPyJson: bad token at ${i}`);
    i = re.lastIndex;
    return m;
  };
  function value() {
    ws();
    const ch = text[i];
    if (ch === '{') {
      i += 1;
      const out = {};
      ws();
      if (text[i] === '}') { i += 1; return out; }
      for (;;) {
        ws();
        const key = JSON.parse(match(STRING)[0]);
        ws();
        if (text[i] !== ':') throw new SyntaxError(`loadPyJson: expected : at ${i}`);
        i += 1;
        out[key] = value();
        ws();
        if (text[i] === ',') { i += 1; continue; }
        if (text[i] === '}') { i += 1; return out; }
        throw new SyntaxError(`loadPyJson: expected , or } at ${i}`);
      }
    }
    if (ch === '[') {
      i += 1;
      const out = [];
      ws();
      if (text[i] === ']') { i += 1; return out; }
      for (;;) {
        out.push(value());
        ws();
        if (text[i] === ',') { i += 1; continue; }
        if (text[i] === ']') { i += 1; return out; }
        throw new SyntaxError(`loadPyJson: expected , or ] at ${i}`);
      }
    }
    if (ch === '"') return JSON.parse(match(STRING)[0]);
    if (ch === 't' || ch === 'f' || ch === 'n') return JSON.parse(match(LITERAL)[0]);
    const m = match(NUMBER);
    return m[1] !== undefined || m[2] !== undefined ? pyFloat(Number(m[0])) : Number(m[0]);
  }
  const out = value();
  ws();
  if (i !== text.length) throw new SyntaxError(`loadPyJson: trailing data at ${i}`);
  return out;
}

const readPyFixture = (name) => loadPyJson(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
// Same files, floats kept: the report inputs (specs, targets) come from here.
const PLAN_CASES_PY = readPyFixture('plan_cases.json').cases;
const REPORT_ONLY = readFixture('report_only.json').cases;
const REPORT_ONLY_PY = readPyFixture('report_only.json').cases;

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
  _depth_of: [W.depthOf, false],
};
// Not plain fn(args) -> result rows; tested on their own below.
const SPECIAL = new Set(['check_units', 'plan_region_errors']);

test('every helper in helpers.json is covered (none silently skipped)', () => {
  for (const key of Object.keys(HELPERS)) {
    assert.ok(key in HELPER_FNS || SPECIAL.has(key), `no test for helper ${key}`);
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

// --- report() ------------------------------------------------------------------

test('loadPyJson keeps Python floats as pyFloat and ints as plain numbers', () => {
  const v = loadPyJson('{"a": 6450.0, "b": 6450, "c": [1e+16, -0.0, 2.5, -3], "d": "x\\u00e9\\"", "e": [true, false, null, {}, []]}');
  assert.ok(isPyFloat(v.a) && +v.a === 6450);
  assert.equal(v.b, 6450);
  assert.ok(isPyFloat(v.c[0]) && isPyFloat(v.c[1]) && isPyFloat(v.c[2]));
  assert.ok(Object.is(+v.c[1], -0));
  assert.equal(v.c[3], -3);
  assert.equal(v.d, 'xé"');
  assert.deepEqual(v.e, [true, false, null, {}, []]);
  assert.equal(dumpsPy(v), '{"a": 6450.0, "b": 6450, "c": [1e+16, -0.0, 2.5, -3], "d": "x\\u00e9\\"", "e": [true, false, null, {}, []]}');
  // Structure and order are JSON.parse's, floats aside.
  const fixtureText = fs.readFileSync(path.join(FIXTURE_DIR, 'report_only.json'), 'utf8');
  const unwrap = (x) => {
    if (isPyFloat(x)) return x.value;
    if (Array.isArray(x)) return x.map(unwrap);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, unwrap(y)]));
    return x;
  };
  assert.deepEqual(unwrap(loadPyJson(fixtureText)), JSON.parse(fixtureText));
});

test('isTileCentre and checkUnits treat a float position the way Python does', () => {
  assert.equal(W.isTileCentre(6450), true);
  assert.equal(W.isTileCentre(pyFloat(6450)), false);
  const problems = W.checkUnits({ key: 'f', width: 128, entry_spawn: { x: pyFloat(6450), y: 6450 } });
  assert.deepEqual(problems, [
    'f.entry_spawn.x = 6450.0 is not a tile centre - looks like TILE coordinates where '
    + 'something2 reads PIXELS (100px per tile, so tile n is n*100+50)',
  ]);
});

function assertReportText(got, c, where) {
  // Structural first, so a failure shows a readable diff, then the bytes.
  assert.deepEqual(JSON.parse(dumpsPy(got)), c.report, `${where} (value)`);
  assert.equal(dumpsPy(got, { indent: 2 }), c.report_json, `${where} (json.dumps text)`);
}

test('report: every fixture report is byte-equal to Python json.dumps text', () => {
  const failed = [];
  let n = 0;
  const check = (got, text, id) => { n += 1; if (dumpsPy(got, { indent: 2 }) !== text) failed.push(id); };
  PLAN_CASES.forEach((c, i) => {
    check(W.report(loadPyJson(c.to_json), PLAN_CASES_PY[i].report_target), c.report_json, `plan:${c.id}`);
  });
  check(W.report(loadPyJson(BOX.to_json), BOX.report_target), BOX.report_json, BOX.id);
  REPORT_ONLY.forEach((c, i) => {
    check(W.report(REPORT_ONLY_PY[i].spec, REPORT_ONLY_PY[i].target), c.report_json, `only:${c.id}`);
  });
  assert.equal(n, PLAN_CASES.length + 1 + REPORT_ONLY.length);
  assert.equal(n, 69);
  assert.deepEqual(failed, [], `reports not byte-equal: ${failed.join(', ')}`);
});

PLAN_CASES.forEach((c, i) => {
  test(`report on plan case ${c.id} (the Python spec, and the JS planRegion spec)`, () => {
    const target = PLAN_CASES_PY[i].report_target;
    assertReportText(W.report(loadPyJson(c.to_json), target), c, c.id);
    assertReportText(W.report(W.planRegion(structuredClone(c.args)), target), c, `${c.id} via planRegion`);
  });
});

test('report on the live box parity-somet644 spec matches the box report', () => {
  assertReportText(W.report(loadPyJson(BOX.to_json), BOX.report_target), BOX, BOX.id);
  assert.deepEqual(BOX.report, BOX.box_report);
});

REPORT_ONLY.forEach((c, i) => {
  test(`report-only case ${c.id}`, () => {
    const { spec, target } = REPORT_ONLY_PY[i];
    assertReportText(W.report(spec, target), c, c.id);
  });
});

test('report-only float case really feeds floats (not ints) to report', () => {
  const i = REPORT_ONLY.findIndex((c) => c.id === 'units-float-and-dict-positions');
  assert.ok(i >= 0);
  const w = REPORT_ONLY_PY[i].spec.worlds[0];
  assert.ok(isPyFloat(w.entry_spawn.x));
  // A plain JSON.parse would lose that and accept 6450 as a tile centre.
  const lossy = W.report(REPORT_ONLY[i].spec, REPORT_ONLY[i].target);
  assert.notEqual(dumpsPy(lossy, { indent: 2 }), REPORT_ONLY[i].report_json);
});

describeToName();
function describeToName() {
  const base = () => {
    const spec = W.planRegion({ name: 'Links', world_count: 3 });
    spec.worlds.push({
      key: 'links_lonely', name: 'links_lonely', biomes: ['Mire'], density: 'normal',
      width: 128, height: 128, is_entry: false, allowed_creature_types: W.spawnable(['Mire']),
    });
    // links_lonely's only exit is a cross-region doorway: to_name, no to.
    spec.links.push({ from: 'links_lonely', edge: 'W', to_name: 'Far Away' });
    return spec;
  };

  test('to_name link: report does not throw', () => {
    assert.doesNotThrow(() => W.report(base(), 6.0));
  });

  test('to_name link: no "names a world that does not exist" problem', () => {
    const r = W.report(base(), 6.0);
    assert.deepEqual(r.problems.filter((p) => p.includes('names a world that does not exist')), []);
    assert.ok(!r.problems.some((p) => p.includes('Far Away')));
  });

  test('to_name link: its source world is not reported unreachable', () => {
    const r = W.report(base(), 6.0);
    assert.ok(!r.problems.includes('links_lonely has no links - it is unreachable'), r.problems.join('\n'));
    // Control: without the doorway it IS unreachable, so the assertion can fail.
    const spec = base();
    spec.links.pop();
    assert.ok(W.report(spec, 6.0).problems.includes('links_lonely has no links - it is unreachable'));
  });
}

test('a 6.0 target gives a caveat and still ok:true - caveats are not problems', () => {
  const r = W.report(W.planRegion({ name: 'Gap', world_count: 4, target_per_screen: 6.0 }), 6.0);
  assert.equal(r.problems.length, 0);
  assert.equal(r.ok, true);
  assert.equal(r.caveats.length, 1);
  assert.match(r.caveats[0], /^asked for 6\.0 creatures\/screen/);
});

test('report does not mutate its spec', () => {
  for (const [i, c] of REPORT_ONLY.entries()) {
    const spec = REPORT_ONLY_PY[i].spec;
    const before = dumpsPy(spec);
    W.report(spec, REPORT_ONLY_PY[i].target);
    assert.equal(dumpsPy(spec), before, c.id);
  }
});
