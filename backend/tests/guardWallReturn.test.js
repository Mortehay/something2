// SOMET-154 — a displaced village guard must get back to its post even though
// the village's own wall ring stands between it and home.
//
// Every fixture in guardTick.test.js uses `isWalkable: () => true`. On an
// unobstructed plane a greedy "steer at the post" step always works, which is
// exactly why the whole guard suite shipped green while both of Vale Crossing's
// guards were stranded outside their own walls (1685px and 3755px from their
// posts, persisted by the authority). These tests use the REAL wall ring.
const test = require('node:test');
const assert = require('node:assert');
const {
  CreatureSim, GUARD_HOME_EPSILON, GUARD_LEASH_RADIUS,
  findHomePath, GUARD_PATH_RANGE,
} = require('../src/authority/creatures');

const TILE = 100;

// Vale Crossing's village, read straight off mapService.stampVillage's geometry
// for the live row: box rows 28..31 x cols 28..33, gate on the E edge at
// (row 30, col 33). villageGatePosts puts the two guards on the interior tiles
// flanking that gate: (col 32, row 29) and (col 32, row 30) — i.e. the pixel
// centres (3250,2950) and (3250,3050), which are the exact home_x/home_y of
// the two stranded rows.
const VILLAGE = { minRow: 28, minCol: 28, width: 6, height: 4 };
const R_MAX = VILLAGE.minRow + VILLAGE.height - 1; // 31
const C_MAX = VILLAGE.minCol + VILLAGE.width - 1;  // 33
const GATE = { row: 30, col: C_MAX };
const HOME_A = { x: 3250, y: 2950 };
const HOME_B = { x: 3250, y: 3050 };

function onRing(row, col) {
  if (row < VILLAGE.minRow || row > R_MAX || col < VILLAGE.minCol || col > C_MAX) return false;
  return row === VILLAGE.minRow || row === R_MAX || col === VILLAGE.minCol || col === C_MAX;
}

// Extra walls a single test may stamp on top of the village (used for the
// sealed-pocket case). Reset by makeMap().
let extraWalls = new Set();

function walkableTile(row, col) {
  if (extraWalls.has(`${row},${col}`)) return false;
  if (!onRing(row, col)) return true;
  return row === GATE.row && col === GATE.col; // the gate is the only way in
}

function makeMap(extra = []) {
  extraWalls = new Set(extra);
  return {
    chunkSize: 64,
    isWalkable: (x, y) => walkableTile(Math.floor(y / TILE), Math.floor(x / TILE)),
    speedAt: () => 1,
  };
}

// chunkSize 64 tiles => chunk (0,0) covers x/y in [0, 6400). Every coordinate
// used below sits inside it, so one key keeps the whole fixture active.
const KEYS = new Set(['0,0']);

function guardAt(cx, cy, home, over = {}) {
  return {
    id: 'g', type: 'Village Guard', x: cx - 24, y: cy - 24, hp: 300,
    faction: 'guard', home_x: home.x, home_y: home.y, ...over,
  };
}

function distHome(g, home) {
  return Math.hypot(g.x + g.width / 2 - home.x, g.y + g.height / 2 - home.y);
}

// Ticks the sim and reports the largest single-tick displacement of `g`.
// Every "did it get home?" assertion below is paired with a check on this:
// the snap-home last resort would satisfy "reaches its post" trivially, so a
// test that only looked at the final position would pass against a fix that
// teleports every guard and never walks one anywhere. One tick of walking is
// speed(40) * dt, so anything above that is a jump.
function run(sim, ticks, g, dt = 0.1, players = []) {
  let maxStep = 0;
  for (let i = 0; i < ticks; i++) {
    const px = g.x, py = g.y;
    sim.tick(dt, KEYS, players, 1000 + i * dt);
    maxStep = Math.max(maxStep, Math.hypot(g.x - px, g.y - py));
  }
  return maxStep;
}
const WALK_STEP_LIMIT = 40 * 0.1 + 1; // one tick of walking at dt=0.1, plus slack

// --- the wall itself, sanity-checked before anything depends on it ---------

test('fixture: the village wall ring is impassable except at the gate', () => {
  const map = makeMap();
  // A wall tile on each edge.
  assert.equal(map.isWalkable(28 * TILE + 50, 28 * TILE + 50), false, 'NW corner is wall');
  assert.equal(map.isWalkable(30 * TILE + 50, 31 * TILE + 50), false, 'S edge is wall');
  assert.equal(map.isWalkable(28 * TILE + 50, 30 * TILE + 50), false, 'W edge is wall');
  assert.equal(map.isWalkable(33 * TILE + 50, 29 * TILE + 50), false, 'E edge above the gate is wall');
  // The gate, the interior, and the open field are walkable.
  assert.equal(map.isWalkable(GATE.col * TILE + 50, GATE.row * TILE + 50), true, 'gate is open');
  assert.equal(map.isWalkable(HOME_A.x, HOME_A.y), true, 'post A is inside and walkable');
  assert.equal(map.isWalkable(HOME_B.x, HOME_B.y), true, 'post B is inside and walkable');
  assert.equal(map.isWalkable(2500, 3050), true, 'open ground west of the village');
});

// --- the defect: displaced at every bearing, must reach the post -----------

// Five bearings around the ring. Only the SE one can see the gate edge without
// rounding a corner; W/NW/N/S all have wall between them and home, and each
// jams a greedy step at a different face.
const BEARINGS = [
  ['W',  2500, 3050],
  ['NW', 2500, 2500],
  ['N',  3150, 2450],
  ['S',  3150, 3650],
  ['SE', 3850, 3550],
];

for (const [name, sx, sy] of BEARINGS) {
  test(`a guard displaced ${name} of the village walls returns to its post`, () => {
    const s = new CreatureSim(makeMap(), () => 0.5);
    s.addCreatures([guardAt(sx, sy, HOME_A)]);
    const g = s.creatures.get('g');
    const start = distHome(g, HOME_A);
    assert.ok(start > GUARD_LEASH_RADIUS, `precondition: ${name} start must be outside the leash`);

    const maxStep = run(s, 1500, g);

    const end = distHome(g, HOME_A);
    assert.ok(end <= GUARD_HOME_EPSILON,
      `guard displaced ${name} did not reach its post: ${start.toFixed(0)}px -> ${end.toFixed(0)}px (at ${g.x},${g.y})`);
    assert.equal(g.mode, 'guard', 'guard must be standing its post at the end');
    assert.ok(maxStep <= WALK_STEP_LIMIT,
      `guard displaced ${name} jumped ${maxStep.toFixed(1)}px in one tick — it must WALK around the ring, not snap home`);
  });
}

test('the two live Vale Crossing rows both recover from where the authority persisted them', () => {
  // Verbatim from world a134b3c5's world_creatures rows (updated_at 2026-08-07).
  const rows = [
    { at: [2949.32 + 24, 4608.28 + 24], home: HOME_A },
    { at: [277.34 + 24, 5345.53 + 24], home: HOME_B },
  ];
  for (const { at, home } of rows) {
    const s = new CreatureSim(makeMap(), () => 0.5);
    s.addCreatures([guardAt(at[0], at[1], home)]);
    const g = s.creatures.get('g');
    const start = distHome(g, home);
    assert.ok(start > 1000, `precondition: live row must start far from home (${start})`);

    const maxStep = run(s, 3000, g);

    assert.ok(distHome(g, home) <= GUARD_HOME_EPSILON,
      `stranded live guard never got home: ${start.toFixed(0)}px -> ${distHome(g, home).toFixed(0)}px`);
    assert.equal(g.mode, 'guard');
    assert.ok(maxStep <= WALK_STEP_LIMIT,
      `stranded live guard jumped ${maxStep.toFixed(1)}px in one tick instead of walking home`);
  }
});

// --- the detour must not itself become a new way to wander off -------------

// HONESTY NOTE: unlike every test above, this one does NOT fail against the
// shipped code, and it is not claimed to. The ticket's premise that the
// unclamped return step "lets the drift grow" does not hold: greedy steering
// aims each axis AT the post and the per-tick step (2px at the authority's
// 50ms tick) never overshoots, so distance-to-post is monotonically
// non-increasing under the old code too — a sweep of every walkable start in a
// 2200..4300 box around this village found a maximum outward drift of exactly
// 0px pre-fix. The 1685px/3755px live displacements therefore came from
// something OTHER than the return step (knockback, respawn, or a terrain
// regeneration that moved the village), which is outside this file.
//
// What this pins is the risk the FIX introduces: path-following is the first
// thing that can legitimately steer a guard away from its post, so it must
// still never carry one further out than where it started.
test('the walk-home detour never carries a guard further out than it started', () => {
  // Due west, so the greedy vector points straight into the W wall and the
  // detour around the ring is the longest one this village produces.
  const s = new CreatureSim(makeMap(), () => 0.5);
  s.addCreatures([guardAt(2500, 3050, HOME_A)]);
  const g = s.creatures.get('g');
  let worst = distHome(g, HOME_A);
  const start = worst;
  for (let i = 0; i < 1500; i++) {
    s.tick(0.1, KEYS, [], 1000 + i);
    worst = Math.max(worst, distHome(g, HOME_A));
  }
  // A path-following detour is allowed to route around the ring, but never
  // outward past where the guard began.
  assert.ok(worst <= start + 1e-6,
    `guard drifted further from home while returning: ${start.toFixed(0)} -> peak ${worst.toFixed(0)}`);
});

// --- last resort: no route at all -----------------------------------------

test('a guard sealed in a pocket with no route home is put back on its post', () => {
  // A closed 3x3 wall box around (col 10, row 10); the guard sits in its middle
  // tile. No walkable path exists, so no amount of pathfinding can help.
  const pocket = [];
  for (let r = 9; r <= 11; r++) {
    for (let c = 9; c <= 11; c++) {
      if (r === 10 && c === 10) continue;
      pocket.push(`${r},${c}`);
    }
  }
  const s = new CreatureSim(makeMap(pocket), () => 0.5);
  s.addCreatures([guardAt(10 * TILE + 50, 10 * TILE + 50, HOME_A)]);
  const g = s.creatures.get('g');
  assert.ok(distHome(g, HOME_A) > 2000, 'precondition: sealed guard starts far from home');

  const maxStep = run(s, 200, g);

  assert.ok(distHome(g, HOME_A) <= GUARD_HOME_EPSILON,
    `sealed guard was left off its post at ${g.x},${g.y}`);
  assert.equal(g.mode, 'guard');
  assert.equal(g.dirty, true, 'the reposition must be broadcast, not applied silently');
  // The inverse of the walk assertions above: this case CANNOT be walked, so
  // the recovery here must be the jump — proving the two paths are distinct
  // and that the bearing tests are not just watching the same snap.
  assert.ok(maxStep > WALK_STEP_LIMIT,
    'a sealed guard has no route, so the recovery must be the snap, not a walk');
});

// --- the intended behaviours must survive the fix --------------------------

test('a guard already at its post does not move and never snaps', () => {
  const s = new CreatureSim(makeMap(), () => 0.5);
  s.addCreatures([guardAt(HOME_A.x, HOME_A.y, HOME_A)]);
  const g = s.creatures.get('g');
  const { x, y } = g;
  run(s, 400, g);
  assert.equal(g.x, x, 'idle guard must not move in x');
  assert.equal(g.y, y, 'idle guard must not move in y');
  assert.equal(g.mode, 'guard');
});

test('a guard inside the walls still chases a hostile and is never teleported mid-fight', () => {
  const s = new CreatureSim(makeMap(), () => 0.5);
  s.addCreatures([
    guardAt(HOME_A.x, HOME_A.y, HOME_A),
    // Just inside the village, 200px from the post: within GUARD_AGGRO_RADIUS
    // and within GUARD_LEASH_RADIUS of home, so a legitimate target.
    { id: 'h', type: 'Slime', x: HOME_A.x - 200 - 24, y: HOME_A.y - 24, hp: 100000 },
  ]);
  const g = s.creatures.get('g');
  const positions = [];
  for (let i = 0; i < 200; i++) {
    s.tick(0.1, KEYS, [], 1000 + i);
    positions.push({ x: g.x, y: g.y });
  }
  assert.equal(g._target, 'h', 'guard must hold its target');
  assert.equal(g.mode, 'chase');
  assert.ok(s.creatures.get('h').hp < 100000, 'guard must be damaging the hostile');
  // No frame may move the guard further than one tick of walking (4px at
  // dt=0.1 x 40px/s, plus slack) — a snap-home would show up as a single
  // ~200px jump in this trace.
  for (let i = 1; i < positions.length; i++) {
    const step = Math.hypot(positions[i].x - positions[i - 1].x, positions[i].y - positions[i - 1].y);
    assert.ok(step < 12, `guard teleported ${step.toFixed(1)}px in one tick during combat`);
  }
});

test('a guard still stops at the leash edge rather than chasing through the gate', () => {
  const s = new CreatureSim(makeMap(), () => 0.5);
  s.addCreatures([
    guardAt(HOME_A.x, HOME_A.y, HOME_A),
    // Far outside the leash from home: must never be acquired.
    { id: 'h', type: 'Slime', x: HOME_A.x + GUARD_LEASH_RADIUS + 400, y: HOME_A.y, hp: 100 },
  ]);
  const g = s.creatures.get('g');
  run(s, 300, g);
  assert.equal(g._target, null, 'must not acquire an out-of-leash hostile');
  assert.ok(distHome(g, HOME_A) <= GUARD_LEASH_RADIUS, 'guard must stay inside its leash');
});

// --- the path search itself -----------------------------------------------

test('findHomePath routes through the gate, not through the wall', () => {
  const map = makeMap();
  const path = findHomePath(map, 2500, 3050, HOME_A);
  assert.ok(Array.isArray(path) && path.length > 0, 'a path around the ring must exist');
  for (const p of path) {
    assert.equal(map.isWalkable(p.x, p.y), true, `waypoint ${p.x},${p.y} lands in a wall`);
  }
  // Every hop is one orthogonal tile: a diagonal hop could cut a wall corner
  // the per-axis collision clamp would refuse.
  for (let i = 1; i < path.length; i++) {
    const dx = Math.abs(path[i].x - path[i - 1].x);
    const dy = Math.abs(path[i].y - path[i - 1].y);
    assert.ok((dx === TILE && dy === 0) || (dx === 0 && dy === TILE),
      `non-orthogonal hop ${dx},${dy} between waypoints ${i - 1} and ${i}`);
  }
  assert.deepEqual(path[path.length - 1], { x: HOME_A.x, y: HOME_A.y }, 'path must end on the post');
  // The gate is the ring's only opening, so any legal route uses it.
  assert.ok(path.some((p) => p.x === GATE.col * TILE + 50 && p.y === GATE.row * TILE + 50),
    'the route must pass through the gate tile');
});

test('findHomePath gives up (rather than flood-filling) beyond its search box', () => {
  const map = makeMap();
  const farX = HOME_A.x + (GUARD_PATH_RANGE + 5) * TILE;
  assert.equal(findHomePath(map, farX, HOME_A.y, HOME_A), null);
});

test('findHomePath returns null for a guard already in its post tile', () => {
  const map = makeMap();
  assert.equal(findHomePath(map, HOME_A.x + 10, HOME_A.y - 10, HOME_A), null);
});
