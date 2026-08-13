const test = require('node:test');
const assert = require('node:assert');

const { buildLandmarks } = require('../src/services/landmarks');

// The shapes loadWorld actually builds, so these fixtures cannot drift into
// testing a convenient invention:
//   waypoints:   Map tileKey -> { id, x, y, name }        (server.js ~line 505)
//   portalLinks: Map tileKey -> { id, toWorldId, toX, toY, fromX, fromY }
//                                                          (server.js ~line 488)
function wp(id, x, y, name) {
  return [`${Math.floor(y / 100)},${Math.floor(x / 100)}`, { id, x, y, name }];
}
function portal(id, fromX, fromY, toName) {
  return [`${Math.floor(fromY / 100)},${Math.floor(fromX / 100)}`,
    { id, fromX, fromY, toName, toWorldId: 'w-other', toX: 500, toY: 500 }];
}

test('a world with only waypoints reports them as waypoint landmarks', () => {
  const out = buildLandmarks({
    waypoints: new Map([wp('a', 3250, 3250, 'Old Trailhead Commons')]),
    portalLinks: new Map(),
    activatedIds: new Set(),
  });
  assert.deepStrictEqual(out, [
    { kind: 'waypoint', x: 3250, y: 3250, name: 'Old Trailhead Commons', activated: false },
  ]);
});

test('a world with only portals reports them, labelled by destination', () => {
  const out = buildLandmarks({
    waypoints: new Map(),
    portalLinks: new Map([portal('p', 3150, 3450, 'Windwatch Pass')]),
    activatedIds: new Set(),
  });
  assert.deepStrictEqual(out, [
    { kind: 'portal', x: 3150, y: 3450, name: 'To Windwatch Pass', activated: false },
  ]);
});

test('a portal whose destination name is missing still gets a usable label', () => {
  const out = buildLandmarks({
    waypoints: new Map(),
    portalLinks: new Map([portal('p', 100, 200, undefined)]),
    activatedIds: new Set(),
  });
  assert.strictEqual(out[0].name, 'Portal');
});

test('both kinds come back together, ordered by row then column', () => {
  // Deliberately inserted out of order: the Map's insertion order must not be
  // what the wire sees, or the client's marker list reshuffles between joins.
  const out = buildLandmarks({
    waypoints: new Map([wp('a', 3250, 3250, 'Commons')]),
    portalLinks: new Map([
      portal('p2', 3150, 3450, 'Windwatch Pass'),
      portal('p1', 3050, 1050, 'Thornbriar Reach'),
    ]),
    activatedIds: new Set(),
  });
  assert.deepStrictEqual(
    out.map((l) => [l.y, l.x]),
    [[1050, 3050], [3250, 3250], [3450, 3150]],
  );
});

test('activation is per character: the same waypoint reads both ways', () => {
  const waypoints = new Map([wp('a', 3250, 3250, 'Commons')]);
  const lit = buildLandmarks({ waypoints, portalLinks: new Map(), activatedIds: new Set(['a']) });
  const dark = buildLandmarks({ waypoints, portalLinks: new Map(), activatedIds: new Set() });
  assert.strictEqual(lit[0].activated, true);
  assert.strictEqual(dark[0].activated, false);
});

test('a portal is never activated, even if its id collides with an activated waypoint id', () => {
  // activatedIds holds WAYPOINT ids. A portal id must not be looked up in it --
  // portals are not activated, walking into one uses it.
  const out = buildLandmarks({
    waypoints: new Map(),
    portalLinks: new Map([portal('shared-id', 100, 100, 'Elsewhere')]),
    activatedIds: new Set(['shared-id']),
  });
  assert.strictEqual(out[0].activated, false);
});

test('a world with neither yields an empty array, never a throw', () => {
  assert.deepStrictEqual(
    buildLandmarks({ waypoints: new Map(), portalLinks: new Map(), activatedIds: new Set() }),
    [],
  );
});

test('absent inputs yield an empty array -- 86 live worlds have no landmarks at all', () => {
  // The join frame is built for every world. If this threw, joining any of the
  // 86 landmark-free worlds would fail outright rather than draw no marker.
  assert.deepStrictEqual(buildLandmarks({}), []);
  assert.deepStrictEqual(buildLandmarks({ waypoints: null, portalLinks: null }), []);
  assert.deepStrictEqual(buildLandmarks(undefined), []);
});
