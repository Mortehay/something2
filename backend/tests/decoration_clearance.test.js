const test = require('node:test');
const assert = require('node:assert');
const {
  worldConfig, generateRegion, generateChunk, generateChunkDecorations,
  isExcludedBlockerCell, inDoorwayApproach, portalTileCells,
  DOORWAY_TILES, DOORWAY_CLEAR_LENGTH, DOORWAY_CLEAR_HALFWIDTH,
  PORTAL_CLEAR_RADIUS, VILLAGE_RING, DECO_CELL,
} = require('../src/services/mapService');
const { assertNavigable, blockingDecorationCells } = require('../src/services/navigability');

// SOMET-510. THE INVARIANT THIS FILE EXISTS FOR: a blocking decoration is never
// generated on a point a player can arrive at, nor on the corridor out of it.
//
// WHY EVERY TEST HERE RUNS WITH CONNECTOR ROADS OFF (`noGeneratedRoads: true`).
// SOMET-349's connector roads run between every pair of doorways and every
// village, and generateChunkDecorations skips carved path cells for ALL
// decorations. So with roads on, every doorway and gate already sits at the end
// of a decoration-free corridor -- the road carves the very clearance this rule
// is supposed to guarantee, and every assertion below would pass whether or not
// the rule existed. SOMET-366 was cancelled on exactly that reading: the live
// scanner reported 0 of 100 worlds sealed, which was the roads talking.
//
// Measured on the 100 seeded worlds with the connector network off, BEFORE this
// rule: 11 arrival points across 10 worlds had a blocking decoration sitting on
// the arrival tile, the entry world's own E doorway among them. After: 0.
// `decoration_clearance_db.test.js` re-runs that measurement against the live
// rows; this file pins the rule itself with no database.

// A forest world: every terrain tile is `grass`, and the only decoration def
// that spawns on grass is a BLOCKING tree with chance 1. So every eligible tile
// the clump field and fill roll admit becomes a blocker -- the densest legal
// world the generator can produce, which is what makes an un-cleared arrival
// tile a certainty rather than a coin flip.
const TILE_TYPES = {
  grass: { walkable: true, speed: 1 },
  dirt: { walkable: true, speed: 1 },
  map_wall: { walkable: false, speed: 1 },
  map_doorway: { walkable: true, speed: 1 },
  wooden_wall: { walkable: false, speed: 1 },
  village_gate: { walkable: true, speed: 1 },
};

const DEFS = [{ name: 'Tree', walkable: false, spawn_tiles: ['grass'], chance: 1 }];
const PASSABLE_DEFS = [{ name: 'bush', walkable: true, spawn_tiles: ['grass'], chance: 1 }];

function forestWorld(over = {}) {
  return {
    seed: 4242, chunkSize: 64, tileTypes: TILE_TYPES, pathTile: 'dirt',
    width: 64, height: 64, doorways: ['N', 'S', 'E', 'W'],
    biomes: [{ name: 'Wood', terrain_tiles: ['grass'], flora_types: ['Tree'], creature_types: [] }],
    biomeCell: 16,
    // The whole point: judged with no road network, the way seeding judges it.
    noGeneratedRoads: true,
    ...over,
  };
}

// Every blocking decoration the generator places in a bounded world, as
// "row,col" keys. Goes through the REAL generator (generateChunk +
// generateChunkDecorations), not a reimplementation of the placement rules.
function blockers(world, defs = DEFS) {
  const cfg = worldConfig(world);
  const N = cfg.chunkSize;
  const out = new Set();
  for (let cy = 0; cy * N < cfg.bounds.height; cy++) {
    for (let cx = 0; cx * N < cfg.bounds.width; cx++) {
      const tiles = generateChunk(world, cx, cy);
      for (const d of generateChunkDecorations(world, cx, cy, tiles, defs)) {
        if (d.blocking) out.add(`${cy * N + d.row},${cx * N + d.col}`);
      }
    }
  }
  return out;
}

// --- the fixture must be able to fail, or nothing below means anything ------

test('the forest fixture really does bury the map in blockers', () => {
  const world = forestWorld();
  const placed = blockers(world);
  assert.ok(placed.size > 500,
    `fixture must generate a dense blocker field, got ${placed.size} -- `
    + 'every clearance assertion in this file is vacuous otherwise');

  // And with roads ON the corridors would be carved for free. Asserted so the
  // "roads off" discipline in this file is a measured requirement, not a habit.
  const paved = blockers({ ...world, noGeneratedRoads: false });
  assert.ok(paved.size < placed.size,
    `the connector roads must strip blockers (paved=${paved.size} bare=${placed.size}); `
    + 'if they do not, this fixture cannot demonstrate what was masking the defect');
});

// --- AC 1: doorway gap and its inward approach ------------------------------

// Where the gap and the corridor are, derived the same way stampBounds and
// arrivalPoint derive them, so this list cannot drift from the geometry.
function doorwayCorridor(edge, width, height) {
  const midCol = Math.floor(width / 2), midRow = Math.floor(height / 2);
  const cells = [];
  for (let d = 0; d <= DOORWAY_CLEAR_LENGTH; d++) {
    for (let o = -DOORWAY_CLEAR_HALFWIDTH; o <= DOORWAY_CLEAR_HALFWIDTH; o++) {
      if (edge === 'N') cells.push([d, midCol + o]);
      if (edge === 'S') cells.push([height - 1 - d, midCol + o]);
      if (edge === 'W') cells.push([midRow + o, d]);
      if (edge === 'E') cells.push([midRow + o, width - 1 - d]);
    }
  }
  return cells;
}

test('AC1: no blocking decoration on a doorway gap or its inward corridor, roads off', () => {
  const world = forestWorld();
  const placed = blockers(world);
  const offenders = [];
  for (const edge of ['N', 'S', 'E', 'W']) {
    for (const [r, c] of doorwayCorridor(edge, 64, 64)) {
      if (placed.has(`${r},${c}`)) offenders.push(`${edge} (${r},${c})`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    `blocking decorations inside a doorway clearance corridor: ${offenders.join(', ')}`);
});

test('AC1: the corridor is the ONLY thing sparing those cells -- ground beside it is decorated', () => {
  // The complement assertion. Without it, "no blockers in the corridor" would
  // also pass on a world where the generator placed nothing anywhere near the
  // edge, and the test would be measuring the density field, not the rule.
  const world = forestWorld();
  const placed = blockers(world);
  const midCol = 32;
  const justOutside = [];
  for (let d = 0; d <= DOORWAY_CLEAR_LENGTH; d++) {
    // One column further out than the corridor's side wall.
    if (placed.has(`${d},${midCol + DOORWAY_CLEAR_HALFWIDTH + 1}`)) justOutside.push(d);
  }
  assert.ok(justOutside.length > 0,
    'the column immediately beside the N corridor must still be decorated; '
    + 'if it is bare too, this fixture proves nothing about the corridor');
});

test('AC1: a halfwidth-0 corridor would still pocket the arrival -- the width is load-bearing', () => {
  // Measured on the 100 live worlds: clearing only the centre column left a
  // FOUR-CELL POCKET at three doorways, which is the exact failure SOMET-366
  // reported. This pins the reason the halfwidth is not 0 by showing the
  // arrival tile's sideways neighbours are genuinely blocker-eligible ground.
  const world = forestWorld();
  const bare = blockers({
    ...world,
    // No doorways declared -> no corridor -> the generator treats these cells
    // like any other ground, which is what the rule is protecting them from.
    doorways: [],
  });
  const sideways = [`1,${32 - 1}`, `1,${32 + 1}`];
  assert.ok(sideways.some((k) => bare.has(k)),
    'the arrival tile\'s sideways neighbours must be blocker-eligible ground, '
    + 'or a halfwidth of 0 would be harmless and this constant would not matter');
});

test('AC1: the corridor is exactly as wide as the gap, and DECO_CELL deep', () => {
  // Derived, not written down: widening DOORWAY_TILES must widen the corridor,
  // and the depth must stay tied to the clump cell size for the same reason
  // GATE_CORRIDOR_LENGTH is.
  assert.strictEqual(DOORWAY_CLEAR_HALFWIDTH, Math.floor(DOORWAY_TILES / 2));
  assert.strictEqual(DOORWAY_CLEAR_LENGTH, DECO_CELL);
});

test('AC1: inDoorwayApproach closes at both ends -- the stated boundary', () => {
  const bounds = { width: 64, height: 64, doorways: new Set(['N']) };
  const mid = 32;
  const L = DOORWAY_CLEAR_LENGTH, H = DOORWAY_CLEAR_HALFWIDTH;
  assert.strictEqual(inDoorwayApproach(bounds, 0, mid), true, 'the gap itself');
  assert.strictEqual(inDoorwayApproach(bounds, 1, mid), true, 'the arrival tile');
  assert.strictEqual(inDoorwayApproach(bounds, L, mid), true, 'the far end of the lane');
  assert.strictEqual(inDoorwayApproach(bounds, L + 1, mid), false, 'one past the far end');
  assert.strictEqual(inDoorwayApproach(bounds, 1, mid + H), true, 'the lane wall');
  assert.strictEqual(inDoorwayApproach(bounds, 1, mid + H + 1), false, 'one past the lane wall');
  // An edge with no doorway gets no corridor -- clearing a lane into solid wall
  // would be worse than useless.
  assert.strictEqual(inDoorwayApproach(bounds, 63, mid), false, 'S has no doorway here');
  assert.strictEqual(inDoorwayApproach(null, 1, mid), false, 'an unbounded world has no ring');
});

// --- AC 2: portal endpoints -------------------------------------------------

// A tile deep inside a clump on the forest fixture, far from every doorway
// corridor and from the village box: with no portal declared, all NINE cells of
// its clear radius are blocked. Chosen by scanning the fixture's own blocker
// set, not by feel -- the first draft of this test put the portal on ground the
// generator was never going to decorate, and it passed while proving nothing.
const CLUMPED_PORTAL = { row: 12, col: 19 };

test('AC2: no blocking decoration on or around a portal endpoint, roads off', () => {
  const R = PORTAL_CLEAR_RADIUS;
  const { row, col } = CLUMPED_PORTAL;

  // FIRST prove the fixture: with no portal declared, the whole clear radius is
  // solid blockers. Otherwise "no blockers here" is a statement about the
  // density field, not about the rule.
  const withoutPortal = blockers(forestWorld());
  let wouldBeBlocked = 0;
  for (let dr = -R; dr <= R; dr++) {
    for (let dc = -R; dc <= R; dc++) {
      if (withoutPortal.has(`${row + dr},${col + dc}`)) wouldBeBlocked++;
    }
  }
  assert.strictEqual(wouldBeBlocked, (2 * R + 1) ** 2,
    'with no portal declared every cell of the clear radius must be blocked, or '
    + 'the portal rule is being credited for ground nothing was going to decorate');

  const placed = blockers(forestWorld({ portals: [{ x: col * 100, y: row * 100 }] }));
  const offenders = [];
  for (let dr = -R; dr <= R; dr++) {
    for (let dc = -R; dc <= R; dc++) {
      if (placed.has(`${row + dr},${col + dc}`)) offenders.push(`(${row + dr},${col + dc})`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    `blocking decorations within the portal clear radius: ${offenders.join(', ')}`);

  // And the rule is a RADIUS, not a licence to strip the neighbourhood: one
  // cell further out is still decorated.
  assert.ok(placed.has(`${row},${col + R + 1}`) || placed.has(`${row + R + 1},${col}`),
    'ground just outside the portal clear radius must still be decorated');
});

test('AC2: portalTileCells converts world pixels to tiles and drops junk', () => {
  assert.deepStrictEqual(
    portalTileCells({ portals: [{ x: 2050, y: 199 }] }), [{ row: 1, col: 20 }]);
  assert.deepStrictEqual(portalTileCells({}), []);
  assert.deepStrictEqual(portalTileCells({ portals: null }), []);
  assert.deepStrictEqual(portalTileCells({ portals: [null, { x: 1 }, { y: 1 }] }), []);
});

// --- AC 3: village ring and gate corridor -----------------------------------

const VILLAGE = {
  id: 'v1', minRow: 30, minCol: 30, width: 6, height: 5, gateEdge: 'E',
  spawnX: 3250, spawnY: 3250, wallTile: 'wooden_wall', gateTile: 'village_gate',
};

test('AC3: no blocking decoration on the ring just outside a village footprint', () => {
  const world = forestWorld({ villages: [VILLAGE] });
  const placed = blockers(world);
  const rMax = VILLAGE.minRow + VILLAGE.height - 1;
  const cMax = VILLAGE.minCol + VILLAGE.width - 1;
  const offenders = [];
  for (let r = VILLAGE.minRow - VILLAGE_RING; r <= rMax + VILLAGE_RING; r++) {
    for (let c = VILLAGE.minCol - VILLAGE_RING; c <= cMax + VILLAGE_RING; c++) {
      if (placed.has(`${r},${c}`)) offenders.push(`(${r},${c})`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    `blocking decorations on the village footprint or its ring: ${offenders.join(', ')}`);
});

test('AC3: the ring is what spares those cells -- with no village they are decorated', () => {
  const placed = blockers(forestWorld());
  const rMax = VILLAGE.minRow + VILLAGE.height - 1;
  const cMax = VILLAGE.minCol + VILLAGE.width - 1;
  let onRing = 0;
  for (let r = VILLAGE.minRow - VILLAGE_RING; r <= rMax + VILLAGE_RING; r++) {
    for (let c = VILLAGE.minCol - VILLAGE_RING; c <= cMax + VILLAGE_RING; c++) {
      const onFootprint = r >= VILLAGE.minRow && r <= rMax && c >= VILLAGE.minCol && c <= cMax;
      if (!onFootprint && placed.has(`${r},${c}`)) onRing++;
    }
  }
  assert.ok(onRing > 0,
    'with no village declared the ring cells must be blocker-eligible ground');
});

test('AC3: the gate corridor outward from the gate is still spared', () => {
  // SOMET-339's rule, re-asserted here because SOMET-510 rewrote the function
  // that carries it and a silently dropped clause would look exactly like a
  // passing suite.
  const world = forestWorld({ villages: [VILLAGE] });
  const placed = blockers(world);
  const midRow = VILLAGE.minRow + Math.floor(VILLAGE.height / 2);
  const cMax = VILLAGE.minCol + VILLAGE.width - 1;
  const offenders = [];
  for (let d = 1; d <= DECO_CELL; d++) {
    for (let o = -1; o <= 1; o++) {
      if (placed.has(`${midRow + o},${cMax + d}`)) offenders.push(`(${midRow + o},${cMax + d})`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    `blocking decorations in the village gate corridor: ${offenders.join(', ')}`);
});

// --- the rule as a predicate ------------------------------------------------

test('isExcludedBlockerCell covers every arrival kind, and nothing else', () => {
  const cfg = worldConfig(forestWorld({ villages: [VILLAGE] }));
  const spawn = { row: 10, col: 10 };
  const portals = [{ row: 44, col: 20 }];
  const at = (r, c) => isExcludedBlockerCell(cfg, spawn, portals, r, c);

  assert.strictEqual(at(10, 10), true, 'entry spawn');
  assert.strictEqual(at(11, 11), true, 'entry spawn ring');
  assert.strictEqual(at(44, 20), true, 'portal endpoint');
  assert.strictEqual(at(45, 21), true, 'portal ring');
  assert.strictEqual(at(32, 32), true, 'village footprint');
  assert.strictEqual(at(29, 29), true, 'village ring');
  assert.strictEqual(at(32, 37), true, 'village gate corridor');
  assert.strictEqual(at(1, 32), true, 'doorway N arrival');
  assert.strictEqual(at(62, 32), true, 'doorway S arrival');

  // Open ground, well away from every arrival point, must NOT be excluded --
  // an always-true predicate would satisfy every assertion above and strip the
  // map of decorations entirely.
  assert.strictEqual(at(20, 50), false, 'open ground');
  assert.strictEqual(at(50, 8), false, 'open ground');
});

// --- AC 4: the guard ---------------------------------------------------------

test('AC4: assertNavigable is blind to decorations unless it is given the defs', () => {
  // The opt-in is deliberate (a caller with no catalog has nothing to check),
  // so it is pinned: a world sealed by decorations and nothing else must read
  // clean without the defs and dirty with them.
  const world = sealedByDecorations();
  const required = REQUIRED_N;
  assert.deepStrictEqual(assertNavigable(world, required), [],
    'terrain alone must be fine here, or the fixture is testing the wrong thing');
  const problems = assertNavigable(world, required, { decorationDefs: DEFS });
  assert.ok(problems.length > 0, 'with the defs, the decoration seal must be reported');
});

// A 24x24 world with one N doorway whose arrival tile is walkable grass but
// carries a blocking tree, because the doorway corridor is switched off by
// declaring no doorways to worldConfig while still asking about the tile. That
// is the residual-seal shape the guard exists to refuse.
function sealedByDecorations() {
  return {
    seed: 4242, chunkSize: 32, tileTypes: TILE_TYPES, pathTile: 'dirt',
    width: 64, height: 64, doorways: [],
    biomes: [{ name: 'Wood', terrain_tiles: ['grass'], flora_types: ['Tree'], creature_types: [] }],
    biomeCell: 16, noGeneratedRoads: true,
  };
}
const REQUIRED_N = [{ row: 1, col: 32, what: 'arrival via doorway N' }];

test('AC4: the decoration pass names the decoration, and the terrain pass is untouched', () => {
  const problems = assertNavigable(sealedByDecorations(), REQUIRED_N, { decorationDefs: DEFS });
  assert.ok(problems.some((p) => p.includes('is under a blocking decoration')),
    `expected a "under a blocking decoration" report, got: ${problems.join(' | ')}`);
  // No message may claim a TERRAIN problem: the ground is grass. A merged
  // bitmask would have produced exactly that misdiagnosis.
  assert.ok(!problems.some((p) => /is unreachable$/.test(p)),
    `terrain-pass wording must not appear for a decoration seal: ${problems.join(' | ')}`);
});

test('AC4: passable decorations never trip the guard', () => {
  // A bush is walkable. If the pass counted every decoration rather than the
  // blocking ones, a well-planted meadow would fail seeding.
  assert.deepStrictEqual(
    assertNavigable(sealedByDecorations(), REQUIRED_N, { decorationDefs: PASSABLE_DEFS }), [],
    'a walkable decoration must not be treated as a blocker');
});

// --- the wiring that stops the two placers disagreeing ----------------------

test('every production buildWorldGenConfig call passes `links`', () => {
  // A SILENT CLIENT/SERVER DIVERGENCE GUARD, in the same style as
  // worldGenConfig.test.js's "the authority's world SELECT names every column"
  // check, and for the same failure: portals feed generateChunkDecorations'
  // blocker exclusion, so a call site that omits `links` places DIFFERENT
  // decorations from one that supplies them. The REST /chunk preview and the
  // authority's ServerMap would then disagree about which tiles block, which
  // the player sees as rubber-banding, and no test of either one alone catches
  // it.
  //
  // Source text, because the failure IS textual: someone adds a sixth call site
  // and copies the five-argument form. Tests are excluded -- a unit test is
  // entitled to build a portal-free world.
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  };
  walk(path.join(root, 'src'));
  walk(path.join(root, 'scripts'));

  const offenders = [];
  let callSites = 0;
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    // Each call's argument object, from `buildWorldGenConfig({` to its closing
    // `})`. Non-greedy across newlines; these calls are all one object literal.
    for (const m of src.matchAll(/buildWorldGenConfig\(\{([\s\S]*?)\}\)/g)) {
      callSites++;
      // `\blinks\b`, not `links\s*:` -- three of the call sites pass it as an
      // ES6 shorthand property, which has no colon. The colon form was the
      // first draft of this guard and it reported all three as offenders.
      if (!/\blinks\b/.test(m[1])) {
        offenders.push(`${path.relative(root, file)}: ${m[0].slice(0, 60).replace(/\s+/g, ' ')}...`);
      }
    }
  }
  assert.ok(callSites >= 5,
    `expected to find the production buildWorldGenConfig call sites, found ${callSites} -- `
    + 'if the call shape changed, this guard has stopped guarding anything');
  assert.deepStrictEqual(offenders, [],
    `buildWorldGenConfig call(s) without \`links\`, so their decorations differ:\n  ${offenders.join('\n  ')}`);
});

test('AC4: seed-map hands assertNavigable the decoration defs', () => {
  // THE SURVIVING MUTANT. Deleting `{ decorationDefs }` from seed-map's
  // assertNavigable call leaves every other test in this repo green: the
  // decoration pass is opt-in, so an un-opted call reports nothing and seeding
  // goes back to shipping residual seals silently. That is exactly how the
  // SOMET-349 roads guard was inert for three days -- a spread that looked like
  // it stripped the roads and did not -- and the sibling guard for that failure
  // lives in navigability_roads.test.js in this same source-text form.
  //
  // A behavioural test would need to run applyMapSpec against a database it is
  // allowed to write to; the failure being guarded is textual, so the assertion
  // is textual and names the wrong form.
  const src = require('node:fs')
    .readFileSync(require.resolve('../scripts/seed-map.js'), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(src, /assertNavigable\([^)]*\{\s*decorationDefs\s*\}\s*\)/,
    'seed-map must pass { decorationDefs } to assertNavigable, or the decoration '
    + 'pass never runs at seed time and ACs 1-3 have no guard');
  assert.match(src, /loadDecorationDefs\(/,
    'and it must load them from the shared loader, not build its own list');
});

test('AC4: blockingDecorationCells is what both the guard and the scanner flood over', () => {
  const world = sealedByDecorations();
  const fromGuard = blockingDecorationCells(world, DEFS);
  const fromGenerator = blockers(world);
  assert.deepStrictEqual([...fromGuard].sort(), [...fromGenerator].sort(),
    'the guard must see exactly the blockers the generator places');
  assert.strictEqual(blockingDecorationCells(world, []).size, 0, 'no defs, no cells');
});
