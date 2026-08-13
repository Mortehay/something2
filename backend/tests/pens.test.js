const test = require('node:test');
const assert = require('node:assert');
const {
  PEN_LIMITS, penGeometryError, pensOf, placePenCreatures, pennedCreatureFilter,
} = require('../src/services/pens.js');
const {
  placeMapCreatures, worldConfig, collectPathCells, CREATURE_TILE_PX,
} = require('../src/services/mapService.js');

// `dirt` matters: it is what PATH_NAME_RE detects as the path tile, so the
// fixture actually carves roads. Without it cfg.pathTile is null and the
// safe-corridor test below would be vacuous.
const TILE_TYPES = {
  grass: { walkable: true },
  dirt: { walkable: true },
  water: { walkable: false },
};
const WORLD = {
  seed: 4242, chunkSize: 16, width: 48, height: 48, tileTypes: TILE_TYPES,
};
const TYPE = { name: 'Woodland Swarm', hp: 8, defense: 0 };

const tileOf = (c) => [
  Math.floor(c.y / CREATURE_TILE_PX),
  Math.floor(c.x / CREATURE_TILE_PX),
];

const PEN = { minRow: 10, minCol: 10, width: 6, height: 5, count: 5, level: 1 };

test('a pen places exactly its count, every creature inside the box', () => {
  const placed = placePenCreatures(WORLD, PEN, TYPE, 7);
  assert.equal(placed.length, 5);
  for (const c of placed) {
    const [row, col] = tileOf(c);
    assert.ok(row >= 10 && row <= 14, `row ${row} outside the pen`);
    assert.ok(col >= 10 && col <= 15, `col ${col} outside the pen`);
    assert.equal(c.type, 'Woodland Swarm');
    assert.equal(c.level, 1);
  }
});

test('every penned creature carries a home anchor at its own spawn tile', () => {
  // Load-bearing twice over: the anchor is what the authority leashes the
  // creature to (a pen has no walls), AND `home_x IS NOT NULL` is what spares
  // the row from populateWorld's opening DELETE. A pen creature without one is
  // both uncontained and deleted on the next populate.
  for (const c of placePenCreatures(WORLD, PEN, TYPE, 7)) {
    assert.equal(c.homeX, c.x, 'home anchor is not the spawn position');
    assert.equal(c.homeY, c.y, 'home anchor is not the spawn position');
    assert.ok(Number.isFinite(c.homeX) && Number.isFinite(c.homeY));
  }
});

test('no two penned creatures stack on one tile', () => {
  // Stacked sprites read as one creature, so a pen of 5 would look like a pen
  // of 3. Asserted at the maximum density the box allows.
  const placed = placePenCreatures(WORLD, { ...PEN, count: 30 }, TYPE, 7);
  const keys = placed.map((c) => tileOf(c).join(','));
  assert.equal(new Set(keys).size, keys.length, 'two creatures share a tile');
});

test('placement is deterministic for a seed and differs between seeds', () => {
  const a = placePenCreatures(WORLD, PEN, TYPE, 7).map(tileOf);
  const b = placePenCreatures(WORLD, PEN, TYPE, 7).map(tileOf);
  assert.deepEqual(b, a);
  const c = placePenCreatures(WORLD, PEN, TYPE, 99).map(tileOf);
  assert.notDeepEqual(c, a, 'two different seeds produced the identical pen');
});

test('a pen sitting ON a safe road corridor still fills — the whole point', () => {
  // THE regression this module exists for. creatureTileCandidates refuses a
  // safe tile for ANY creature type, not just hostiles, so a pen routed through
  // placeMapCreatures comes out SILENTLY EMPTY inside the road corridor. Both
  // halves are asserted here: that the ordinary placer really does refuse these
  // tiles (otherwise this test proves nothing), and that the pen placer does not.
  const cfg = worldConfig(WORLD);
  const roads = [...collectPathCells(cfg, 0, 0, 48, 48)].map((k) => k.split(',').map(Number));
  assert.ok(roads.length > 0, 'fixture carved no roads — this test would be vacuous');

  // A pen box centred on a real road cell, kept clear of the wall ring.
  const [rr, rc] = roads.find(([r, c]) => r >= 3 && r <= 44 && c >= 3 && c <= 44);
  const onRoad = { minRow: rr - 1, minCol: rc - 1, width: 3, height: 3, count: 4, level: 1 };
  const safeWorld = { ...WORLD, safeRoadRadius: 3 };

  const viaOrdinaryPlacer = placeMapCreatures(safeWorld, 200, [TYPE], 7)
    .map(tileOf)
    .filter(([r, c]) => r >= onRoad.minRow && r < onRoad.minRow + 3
                     && c >= onRoad.minCol && c < onRoad.minCol + 3);
  assert.equal(viaOrdinaryPlacer.length, 0,
    'the ordinary placer put a creature in the corridor — the trap this guards is gone, '
    + 'so re-derive whether the pen placer is still needed');

  const viaPenPlacer = placePenCreatures(safeWorld, onRoad, TYPE, 7);
  assert.equal(viaPenPlacer.length, 4, 'the pen came out short inside the road corridor');
});

test('a pen does not seat creatures on unwalkable tiles or inside a village', () => {
  // Structure is still refused even though policy is not: a creature in a wall
  // is stuck, and one inside a village violates the epic's invariant that only
  // Village Guards stand in a village.
  const village = { minRow: 10, minCol: 10, width: 6, height: 4, gateEdge: 'S' };
  const world = { ...WORLD, villages: [village] };
  const overlapping = { minRow: 8, minCol: 10, width: 6, height: 8, count: 40, level: 1 };
  const placed = placePenCreatures(world, overlapping, TYPE, 7);
  assert.ok(placed.length > 0, 'placed nothing — this test would assert nothing');
  for (const c of placed) {
    const [row, col] = tileOf(c);
    const inVillage = row >= 10 && row <= 13 && col >= 10 && col <= 15;
    assert.ok(!inVillage, `creature at (${row},${col}) is inside the village`);
  }
});

test('a pen larger than its placeable area ships short rather than inventing tiles', () => {
  const placed = placePenCreatures(WORLD, { ...PEN, count: 999 }, TYPE, 7);
  assert.ok(placed.length > 0);
  assert.ok(placed.length <= PEN.width * PEN.height,
    `placed ${placed.length} creatures in a ${PEN.width}x${PEN.height} pen`);
});

test('penGeometryError rejects the ways a hand-edited spec gets a pen wrong', () => {
  const ok = {
    min_row: 10, min_col: 10, width: 6, height: 5,
    creature_type: 'Woodland Swarm', count: 5, level: 1,
  };
  const bounds = { width: 48, height: 48 };
  assert.equal(penGeometryError(ok, bounds), null);

  const cases = [
    [{ ...ok, width: 1 }, /width must be between/],
    [{ ...ok, height: 13 }, /height must be between/],
    [{ ...ok, count: 0 }, /count must be at least 1/],
    [{ ...ok, level: 0 }, /level must be at least 1/],
    [{ ...ok, count: 31 }, /exceeds the 6x5 = 30 tiles/],
    [{ ...ok, creature_type: undefined }, /creature_type is required/],
    [{ ...ok, min_row: 2.5 }, /min_row must be an integer/],
    // The wall ring: rows 44..48 on a 48-tile map overlaps row 47, which is
    // wall. Those tiles can never hold a creature, so the pen would silently
    // under-deliver rather than be a slightly smaller pen.
    [{ ...ok, min_row: 44 }, /strictly inside/],
    [{ ...ok, min_col: 0 }, /strictly inside/],
  ];
  for (const [pen, re] of cases) {
    const err = penGeometryError(pen, bounds);
    assert.ok(err && re.test(err), `accepted ${JSON.stringify(pen)} (got ${err})`);
  }
});

test('pensOf converts the snake_case column into the camelCase the placer reads', () => {
  // The conversion has to happen exactly once. A raw snake_case row reaching
  // placePenCreatures would read minRow/minCol as undefined and enumerate an
  // empty box -- a pen that validates, seeds and holds nothing.
  assert.deepEqual(pensOf({
    pens: [{ min_row: 3, min_col: 4, width: 5, height: 6, creature_type: 'Beast Swarm', count: 2, level: 1 }],
  }), [{ minRow: 3, minCol: 4, width: 5, height: 6, creatureType: 'Beast Swarm', count: 2, level: 1 }]);
  for (const empty of [undefined, null, {}, { pens: null }, { pens: 'nope' }]) {
    assert.deepEqual(pensOf(empty), []);
  }
});

test('the penned-creature predicate tests the ANCHOR against the authored boxes', () => {
  // The bug this pins (SOMET-289 review, F1): the first version of the guard
  // asked only "homed, non-guard, non-portal", which is also exactly what
  // insertVaultChest / spawnFieldChest write. A world declaring both a chest
  // and pens then skipped its pen pass on the FIRST seed and every one after.
  //
  // Structural here -- that the box bounds actually reach the SQL, in world px.
  // The behavioural proof, a chest-carrying spec that still seats its pen, is
  // tests/seed_map_db.test.js's applyMapSpec pen test, which needs a database.
  const { where, params } = pennedCreatureFilter(77, [
    { minRow: 10, minCol: 30, width: 6, height: 5 },
    { minRow: 36, minCol: 14, width: 6, height: 5 },
  ]);
  assert.deepEqual(params, [
    77, 'Village Guard',
    3000, 3600, 1000, 1500,     // cols 30..35, rows 10..14
    1400, 2000, 3600, 4100,     // cols 14..19, rows 36..40
  ]);
  assert.match(where, /home_x IS NOT NULL/);
  assert.match(where, /blocks_portal_id IS NULL/);
  // Two boxes, OR'd -- a creature in either pen is penned, not only one of them.
  assert.equal((where.match(/home_x >= \$/g) || []).length, 2);
  assert.match(where, / OR /);
});

test('a world with no authored pen has no penned creature, whatever else is homed', () => {
  // The empty case must match NOTHING rather than degenerate to "any homed
  // non-guard row" -- that degenerate form is precisely the defect above, and
  // it would make `down` delete a chest guard in a world that authors no pen.
  const { where, params } = pennedCreatureFilter(5, []);
  assert.match(where, /AND false/);
  assert.deepEqual(params, [5, 'Village Guard']);
});
