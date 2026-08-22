const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listSpecs } = require('../scripts/list-maps.js');

// listSpecs() needs no database -- same posture as graphPosition in
// seed_map.test.js. Two things worth pinning: the real shipped specs parse
// cleanly, and a malformed spec is reported rather than thrown (Task 7
// review finding: a single hand-broken *.map.json used to take the whole
// `make list-maps` command down with it, including the OTHER specs and the
// database listing that follows).

// SOMET-355: hub-vale, spine-descent and loop-catacombs used to be three specs
// and are now the three REGIONS of one spec, `vale-region` -- they had to share
// a grid before the doorways between them could be declared. The world count is
// the sum of the three (5 + 8 + 7) and is pinned here for the same reason the
// three separate counts were: it is the cheapest possible witness that a merge
// or an edit did not silently drop a world.
test('listSpecs() returns the shipped specs with name/topology/world-count', () => {
  const specs = listSpecs();
  // >= 2, not === 2: map-planner/SKILL.md tells authors a new spec is
  // "covered automatically -- nothing to register", so a third valid spec
  // an author drops in must not fail this test -- only a missing/broken
  // shipped example should.
  assert.ok(specs.length >= 2, `expected at least the 2 shipped specs, got ${specs.length}`);
  assert.deepEqual(specs.filter((s) => s.error), [], 'no shipped spec should report an error');

  const byName = Object.fromEntries(specs.map((s) => [s.name, s]));
  assert.equal(byName['vale-region'].topology, 'region');
  // 34 = the 20 merged-region worlds plus SOMET-446's three dungeons
  // (7 catacombs upgraded in place, 8 Sunscar Hollows, 6 Rimevault).
  assert.equal(byName['vale-region'].worlds, 34);
  assert.equal(byName['p5-descent'].topology, 'chained-dungeons-plus-surface');
});

test('listSpecs() sorts valid specs by name', () => {
  const names = listSpecs().map((s) => s.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
});

test('listSpecs() reports a malformed spec as an error entry instead of throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'map-specs-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'good.map.json'),
      JSON.stringify({ name: 'good', topology: 'spine', worlds: [{}, {}] }),
    );
    // Deliberately broken JSON -- trailing comma -- the likeliest real
    // trigger (someone hand-edits a spec and fat-fingers it).
    fs.writeFileSync(path.join(dir, 'broken.map.json'), '{ "name": "broken", }');

    let result;
    assert.doesNotThrow(() => { result = listSpecs(dir); });

    const good = result.find((s) => s.file === 'good.map.json');
    const broken = result.find((s) => s.file === 'broken.map.json');

    assert.ok(good, 'the well-formed sibling must still be reported');
    assert.equal(good.error, undefined);
    assert.equal(good.name, 'good');

    assert.ok(broken, 'the malformed file must still appear in the output');
    assert.ok(broken.error, 'a malformed spec must carry an error, not a parsed name/topology/worlds');
    assert.equal(broken.name, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listSpecs() reports an unreadable/non-JSON file as an error, not a throw, alongside valid specs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'map-specs-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.map.json'), JSON.stringify({ name: 'a', topology: 'hub', worlds: [] }));
    fs.writeFileSync(path.join(dir, 'not-json.map.json'), 'this is not json at all');

    const result = listSpecs(dir);
    assert.equal(result.length, 2);
    assert.equal(result.filter((s) => s.error).length, 1);
    assert.equal(result.filter((s) => !s.error).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
