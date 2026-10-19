// SOMET-644. The vendored world-gen reference and its golden fixtures are
// intact.
//
// The JS port is tested for byte parity against fixtures generated from the
// vendored Python (backend/tools/world_gen_ref). Those fixtures are only worth
// anything if (a) the vendored files are exactly the upstream ones recorded in
// SOURCE.md, and (b) the fixtures were generated from THOSE files - a fixture
// set left over from an older reference would make every parity test pass
// against the wrong target. No python, no DB.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REF_DIR = path.join(__dirname, '..', 'tools', 'world_gen_ref');
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'world_gen');
const BACKEND_DIR = path.join(__dirname, '..');
const VENDORED = ['world_gen.py', 'bestiary_p4.json', 'smoke-world-gen.py'];
const FIXTURES = [
  'box_parity.json', 'constants.json', 'helpers.json', 'plan_cases.json', 'report_only.json',
];

// Exact ids, so a dropped or renamed case fails here rather than shrinking the
// parity suite unnoticed.
const PLAN_CASE_IDS = [
  'solo-one-world', 'all-defaults', 'pair-size32-chunk8', 'six-default', 'twelve-horde-224',
  'thirtysix-swarm-224', 'hollow-half', 'chunk64-cell64', 'chunk8-horde', 'cell64-dense-on-tier',
  'nine-linkage', 'eight-bands', 'twenty-horde', 'plan-deep', 'plan-invalid-names',
  'plan-short-dupes', 'entry-arid', 'entry-invalid', 'entry-deep-mixed', 'entry-empty',
  'bestiary-false-thin', 'bestiary-true-thin', 'bestiary-false-default', 'name-accents',
  'name-cjk', 'name-emoji', 'name-symbols-only', 'name-spaces', 'name-case-traps',
  'size-odd-33', 'target-midpoint', 'target-zero', 'swarm-clamp-256', 'no-report-target',
];
const REPORT_ONLY_IDS = [
  'link-to-name', 'to-name-only-exit', 'link-kind-edge', 'graph-no-grid', 'seed-vale-region',
  'seed-p5-descent', 'desolate-abyssal_rift', 'desolate-dreaming_dark',
  'desolate-fallen_sanctum', 'desolate-infernal_gate', 'desolate-pestilent_deep',
  'desolate-shattered_vault', 'desolate-the_maw', 'thin-flora', 'mismatch-empty',
  'mismatch-no-biomes', 'clamp-512', 'bandwidth-224', 'variety-thin', 'leaders-over-cap',
  'unknown-tier', 'missing-density-and-size', 'entries-zero-and-unreachable', 'entries-two',
  'empty-region', 'empty-region-no-keys', 'socket-subset', 'socket-mixed-density',
  'units-tile-coords', 'units-pixel-roads', 'caveat-gap-6', 'caveat-gap-int-6',
  'caveat-tiny-target',
];

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Rows of the form | `relative/path` | ... | `<64 hex>` |. Paths starting with
// `tests/` are relative to backend/ (the pinned fixtures); the rest to REF_DIR.
function resolveRow(rel) {
  return rel.startsWith('tests/') ? path.join(BACKEND_DIR, rel) : path.join(REF_DIR, rel);
}

function sourceHashes() {
  const text = fs.readFileSync(path.join(REF_DIR, 'SOURCE.md'), 'utf8');
  const out = new Map();
  for (const m of text.matchAll(/^\|\s*`([^`]+)`\s*\|.*\|\s*`([0-9a-f]{64})`\s*\|\s*$/gm)) {
    out.set(m[1], m[2]);
  }
  return out;
}

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
}

test('SOURCE.md records a sha256 for every vendored file, and the files match it', () => {
  const recorded = sourceHashes();
  for (const name of VENDORED) {
    assert.ok(recorded.has(name), `SOURCE.md has no sha256 row for ${name}`);
  }
  // Every row, including the live-box capture, not just the three above.
  assert.ok(recorded.size >= VENDORED.length + 2, `only ${recorded.size} hash rows in SOURCE.md`);
  for (const [rel, want] of recorded) {
    assert.equal(sha256(resolveRow(rel)), want, `${rel} differs from SOURCE.md`);
  }
});

test('every golden fixture is pinned by sha256 in SOURCE.md', () => {
  // A regenerated or hand-edited fixture must not silently become the new
  // golden: make_fixtures.py prints the new rows, and updating them here is
  // the reviewed step.
  const recorded = sourceHashes();
  for (const f of FIXTURES) {
    const rel = `tests/fixtures/world_gen/${f}`;
    assert.ok(recorded.has(rel), `SOURCE.md does not pin ${rel}`);
    assert.equal(sha256(resolveRow(rel)), recorded.get(rel),
      `${rel} changed - if the regeneration is intended, paste make_fixtures.py's rows into SOURCE.md`);
  }
});

test('every fixture parses and was generated from the vendored reference', () => {
  const recorded = sourceHashes();
  const files = fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json')).sort();
  assert.deepEqual(files, FIXTURES);
  for (const f of files) {
    const doc = readFixture(f);
    for (const name of VENDORED) {
      assert.equal(doc.reference_sha256[name], recorded.get(name),
        `${f} was generated from a different ${name} - rerun make_fixtures.py`);
    }
  }
});

test('plan cases carry a parseable to_json string and a report', () => {
  const { cases } = readFixture('plan_cases.json');
  assert.deepEqual(cases.map((c) => c.id), PLAN_CASE_IDS);
  for (const c of cases) {
    assert.equal(typeof c.to_json, 'string', c.id);
    assert.ok(c.to_json.endsWith('}\n'), `${c.id}: to_json lost its trailing newline`);
    // ensure_ascii=True: the stored bytes are pure ASCII whatever the name.
    assert.ok(/^[\x00-\x7f]*$/.test(c.to_json), `${c.id}: non-ASCII in to_json`);
    const spec = JSON.parse(c.to_json);
    assert.equal(spec.name, c.args.name, c.id);
    assert.equal(spec.worlds.length, c.args.world_count ?? 6, c.id);
    assert.equal(c.report.worlds.length, spec.worlds.length, c.id);
    assert.equal(typeof c.report.ok, 'boolean', c.id);
    assert.ok(Array.isArray(c.report.caveats), c.id);
  }
});

test('the box parity fixture is the box spec, re-serialised identically', () => {
  const { case: box } = readFixture('box_parity.json');
  assert.equal(box.id, 'box_parity-somet644');
  assert.deepEqual(JSON.parse(box.to_json), box.box_spec);
  assert.deepEqual(box.report, box.box_report);
  assert.equal(box.plan_region_args.world_count, box.post_body.worlds);
});

test('report-only cases and helper rows parse', () => {
  const { cases } = readFixture('report_only.json');
  assert.deepEqual(cases.map((c) => c.id), REPORT_ONLY_IDS);
  assert.ok(cases.some((c) => c.report.caveats.length > 0 && c.report.ok),
    'no case shows a caveat on an ok report');
  const { helpers } = readFixture('helpers.json');
  for (const [name, rows] of Object.entries(helpers)) {
    assert.ok(rows.length > 0, `${name} has no rows`);
    for (const r of rows) {
      if (r.result_json !== undefined) {
        assert.deepEqual(JSON.parse(r.result_json), r.result, `${name}: result_json disagrees`);
      }
    }
  }
  assert.ok(readFixture('constants.json').constants.BIOMES);
});
