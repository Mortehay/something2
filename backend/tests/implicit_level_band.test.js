const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { implicitBandBoundaries } = require('../seeds/mapSpec.js');

const vale = require('../seeds/maps/vale-region.map.json');
const p5 = require('../seeds/maps/p5-descent.map.json');

// Minimal specs, so the rule is exercised on its own rather than through the
// incidental shape of a 34-world region.
const world = (key, band) => ({ key, ...(band ? { level_band: band } : {}) });
const spec = (worlds, links) => ({ name: 't', topology: 'region', worlds, links });

test('an implicit 1-1 world opening by DOORWAY onto a higher band is reported', () => {
  // The exact arrangement a generated region shipped: three surface worlds with
  // no band, walking straight into a declared [3,5].
  const hits = implicitBandBoundaries(spec(
    [world('surface'), world('deep', [3, 5])],
    [{ from: 'surface', edge: 'E', to: 'deep' }],
  ));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].world, 'surface');
  assert.deepEqual(hits[0].neighbourBand, [3, 5]);
  assert.match(hits[0].message, /seeds as 1-1/);
});

test('the same arrangement behind a PORTAL is not reported', () => {
  // A portal is an intentional difficulty gate that joinPolicy enforces, not a
  // step in a ramp. This exclusion is the whole reason the rule is quiet on
  // vale-region, so it is pinned rather than left to the integration case.
  const hits = implicitBandBoundaries(spec(
    [world('surface'), world('dungeon', [12, 18])],
    [{ from: 'surface', kind: 'portal', to: 'dungeon' }],
  ));
  assert.deepEqual(hits, []);
});

test('an implicit world meeting a band that starts at 1 or 2 is continuous, not a gap', () => {
  // 1-1 flowing into [1,2] is exactly what vale-region's ring does. Reporting
  // it would make the warning fire on the correct case.
  for (const band of [[1, 2], [1, 5], [2, 4]]) {
    assert.deepEqual(
      implicitBandBoundaries(spec(
        [world('surface'), world('next', band)],
        [{ from: 'surface', edge: 'E', to: 'next' }],
      )),
      [], `band ${JSON.stringify(band)} should be treated as continuous`,
    );
  }
});

test('a null level_band is treated exactly like an absent one', () => {
  // seed-map.js writes `w.level_band ? ... : 1`, so null and absent are the
  // same to the seeder. A rule that only caught `undefined` would miss half of
  // the thing it exists to catch.
  const hits = implicitBandBoundaries(spec(
    [{ key: 'surface', level_band: null }, world('deep', [3, 5])],
    [{ from: 'surface', edge: 'E', to: 'deep' }],
  ));
  assert.equal(hits.length, 1);
});

test('each offending world is reported once, not once per direction', () => {
  const hits = implicitBandBoundaries(spec(
    [world('a'), world('b', [4, 6])],
    [{ from: 'a', edge: 'E', to: 'b' }, { from: 'b', edge: 'W', to: 'a' }],
  ));
  assert.equal(hits.length, 1);
});

// The controls. These two specs are correct and are seeded routinely; a
// warning that fires on them would be trained away within a week.
test('the checked-in specs are QUIET', () => {
  assert.deepEqual(implicitBandBoundaries(vale), [],
    'vale-region omits bands on its surface ring deliberately -- that ring is the level-1 area, '
    + 'and it reaches the dungeons by guarded portal');
  assert.deepEqual(implicitBandBoundaries(p5), [],
    'p5-descent declares a band on every world');
});

test('vale-region really does contain the arrangement, so the control is not vacuous', () => {
  // If the surface ring ever stopped reaching a higher band, the control above
  // would pass for the wrong reason -- it would be asserting the absence of a
  // situation rather than the rule's correct handling of it. Pin the situation.
  const byKey = new Map(vale.worlds.map(w => [w.key, w]));
  const gates = vale.links.filter(l => l.kind === 'portal').filter((l) => {
    const from = byKey.get(l.from); const to = byKey.get(l.to);
    return from && to && !from.level_band && Array.isArray(to.level_band) && to.level_band[0] > 2;
  });
  assert.ok(gates.length >= 3,
    `expected vale-region's bandless ring to reach >=3 higher-band worlds by portal, got ${gates.length}`);
});
