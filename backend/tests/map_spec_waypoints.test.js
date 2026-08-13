// Map-spec authoring rules for waypoints (SOMET-292).
//
// Every case asserts on the SPECIFIC error text, not on `errors.length > 0`. A
// count-only assertion passes when the validator rejects the spec for some
// entirely unrelated reason -- and these specs are hand-built, so an unrelated
// reason is the likely outcome of a typo in the fixture rather than a rarity.
const test = require('node:test');
const assert = require('node:assert');
const { validateMapSpec } = require('../seeds/mapSpec.js');

// The smallest spec that validates: one entry world, no links. Waypoint cases
// layer onto this so a failure is attributable to the waypoint rule and not to
// the scaffolding.
function baseSpec(over = {}) {
  return {
    name: 'wp-test',
    worlds: [
      { key: 'surface', name: 'WP Surface', seed: '1', grid: [0, 0], width: 40, height: 40, is_entry: true },
      ...(over.extraWorlds ?? []),
    ],
    links: over.links ?? [],
  };
}

function surfaceWith(waypoints, links = []) {
  const spec = baseSpec({ links });
  spec.worlds[0].waypoints = waypoints;
  return spec;
}

const has = (errors, re) => errors.some((e) => re.test(e));

test('the base fixture itself validates clean', () => {
  // Without this, every "rejects X" case below could be passing because the
  // scaffolding is broken rather than because the rule fires.
  assert.deepEqual(validateMapSpec(baseSpec()), []);
});

test('a well-formed standalone waypoint is accepted', () => {
  assert.deepEqual(validateMapSpec(surfaceWith([{ x: 1250, y: 850, name: 'Trailhead Well' }])), []);
});

test('waypoints must be an array', () => {
  const spec = baseSpec();
  spec.worlds[0].waypoints = { x: 1, y: 1, name: 'nope' };
  assert.ok(has(validateMapSpec(spec), /waypoints must be an array/));
});

test('a waypoint needs a non-empty name', () => {
  assert.ok(has(validateMapSpec(surfaceWith([{ x: 100, y: 100, name: '  ' }])),
    /name must be a non-empty string/));
  assert.ok(has(validateMapSpec(surfaceWith([{ x: 100, y: 100 }])),
    /name must be a non-empty string/));
});

test('waypoint coordinates must be integer pixels', () => {
  assert.ok(has(validateMapSpec(surfaceWith([{ x: 100.5, y: 100, name: 'Half Tile' }])),
    /x and y must be integers/));
  assert.ok(has(validateMapSpec(surfaceWith([{ x: -100, y: 100, name: 'Off Map' }])),
    /must not be negative/));
});

test('a waypoint outside the world is rejected', () => {
  // 40 tiles * 100px = 4000, so 4000 is the first pixel past the edge.
  const errs = validateMapSpec(surfaceWith([{ x: 4000, y: 100, name: 'Beyond' }]));
  assert.ok(has(errs, /is outside world "surface"/),
    'a waypoint no player can stand on is a row that can never be activated');
});

test('two waypoints in the same tile are rejected', () => {
  // Different pixels, same tile: only one of them could ever be walked onto,
  // because the authority keys waypoints by tile.
  const errs = validateMapSpec(surfaceWith([
    { x: 1250, y: 850, name: 'First' },
    { x: 1299, y: 899, name: 'Second' },
  ]));
  assert.ok(has(errs, /already has a waypoint on tile/));
});

test('waypoint names are unique across the whole map, not per world', () => {
  const spec = baseSpec({
    extraWorlds: [
      { key: 'pass', name: 'WP Pass', seed: '2', grid: [1, 0], width: 40, height: 40 },
    ],
    links: [{ from: 'surface', edge: 'E', to: 'pass' }],
  });
  spec.worlds[0].waypoints = [{ x: 100, y: 100, name: 'Old Well' }];
  spec.worlds[1].waypoints = [{ x: 100, y: 100, name: 'Old Well' }];
  assert.ok(has(validateMapSpec(spec), /duplicate waypoint name "Old Well"/),
    'the travel list shows waypoints from every world side by side');
});

// --------------------------------------------------------------------------
// Portal-backed waypoints, and the rule the design calls load-bearing.

function portalSpec({ guard = null, is_waypoint, waypoint_name, reversed = false } = {}) {
  const forward = {
    kind: 'portal', from: 'surface', to: 'barrow',
    from_x: 3050, from_y: 1250, to_x: 550, to_y: 550,
  };
  if (guard) forward.guard = guard;
  const links = [forward];
  if (reversed) {
    // A spec is allowed to declare the mirror explicitly; the portal-tile check
    // treats an identical redeclaration as idempotent rather than a conflict.
    const mirror = {
      kind: 'portal', from: 'barrow', to: 'surface',
      from_x: 550, from_y: 550, to_x: 3050, to_y: 1250,
    };
    if (is_waypoint !== undefined) mirror.is_waypoint = is_waypoint;
    if (waypoint_name !== undefined) mirror.waypoint_name = waypoint_name;
    links.push(mirror);
  } else {
    if (is_waypoint !== undefined) forward.is_waypoint = is_waypoint;
    if (waypoint_name !== undefined) forward.waypoint_name = waypoint_name;
  }
  return {
    name: 'wp-portal-test',
    worlds: [
      { key: 'surface', name: 'WP Surface', seed: '1', grid: [0, 0], width: 40, height: 40, is_entry: true },
      { key: 'barrow', name: 'WP Barrow', seed: '2', width: 20, height: 20 },
    ],
    links,
  };
}

test('the portal fixture validates clean without a waypoint', () => {
  assert.deepEqual(validateMapSpec(portalSpec()), []);
  assert.deepEqual(validateMapSpec(portalSpec({ guard: { creature_type: 'Wolf', count: 2 } })), []);
});

test('an unguarded portal may be flagged as a waypoint', () => {
  assert.deepEqual(
    validateMapSpec(portalSpec({ is_waypoint: true, waypoint_name: 'Barrow Stair' })), []);
});

test('is_waypoint must be a real boolean, never coerced', () => {
  for (const bad of ['true', 1, 'yes']) {
    const errs = validateMapSpec(portalSpec({ is_waypoint: bad, waypoint_name: 'Barrow Stair' }));
    assert.ok(has(errs, /is_waypoint must be true or false/), `accepted ${JSON.stringify(bad)}`);
  }
});

test('a flagged portal needs a waypoint_name', () => {
  assert.ok(has(validateMapSpec(portalSpec({ is_waypoint: true })),
    /name must be a non-empty string/));
});

test('is_waypoint on a compass doorway is rejected', () => {
  const spec = baseSpec({
    extraWorlds: [{ key: 'pass', name: 'WP Pass', seed: '2', grid: [1, 0], width: 40, height: 40 }],
    links: [{ from: 'surface', edge: 'E', to: 'pass', is_waypoint: true }],
  });
  assert.ok(has(validateMapSpec(spec), /compass doorway and cannot be a waypoint/));
});

test('a GUARDED portal cannot be a waypoint', () => {
  // The rule the whole slice exists to hold: a waypoint here is a guarded
  // dungeon entrance that is bypassable on the second visit.
  const errs = validateMapSpec(portalSpec({
    guard: { creature_type: 'Wolf', count: 2 },
    is_waypoint: true, waypoint_name: 'Barrow Stair',
  }));
  // The message must NAME the guard: an author facing a rejection otherwise has
  // no way to tell which of a spec's portals it means.
  assert.ok(has(errs, /guarded by 2x Wolf on portal surface->barrow/), errs.join('; '));
  assert.ok(has(errs, /sits on a guarded portal in world "surface"/), errs.join('; '));
});

test('the MIRROR of a guarded portal cannot be a waypoint either', () => {
  // setPortalLink writes two rows per staircase, and insertPortalGuards defends
  // the departure side only. Flagging the arrival side drops a traveller past
  // the guard -- the same bypass, spelled backwards.
  const errs = validateMapSpec(portalSpec({
    guard: { creature_type: 'Wolf', count: 2 },
    reversed: true, is_waypoint: true, waypoint_name: 'Barrow Stair',
  }));
  assert.ok(has(errs, /sits on a guarded portal in world "barrow"/), errs.join('; '));
  assert.ok(has(errs, /arrival side/), errs.join('; '));
});

test('a standalone waypoint on a guarded portal tile is the same bypass', () => {
  // Same hole, spelled without the flag: the waypoint lands on the staircase's
  // own tile, so it is walked onto, lit, and travelled to.
  const spec = portalSpec({ guard: { creature_type: 'Wolf', count: 2 } });
  spec.worlds[0].waypoints = [{ x: 3099, y: 1299, name: 'Sneaky Stone' }];  // same tile as 3050,1250
  const errs = validateMapSpec(spec);
  assert.ok(has(errs, /sits on a guarded portal in world "surface"/), errs.join('; '));
});

test('a waypoint one tile away from a guarded portal is still accepted', () => {
  // The rule is about the staircase tile, not a radius. Pinning this stops a
  // future "make the check safer" edit from quietly widening it into something
  // that rejects legitimate authoring -- and it is the honest boundary: a
  // waypoint INSIDE the dungeon past the guard is a bypass this validator
  // cannot see, recorded as a known gap in the plan doc.
  const spec = portalSpec({ guard: { creature_type: 'Wolf', count: 2 } });
  spec.worlds[0].waypoints = [{ x: 2950, y: 1250, name: 'Outside The Stair' }];
  assert.deepEqual(validateMapSpec(spec), []);
});
