// SOMET-788. A blocking (non-solid) decoration blocks a centred 34 px square
// (DECO_CORE_HALF = 17). It used to block 20 px, which slipped between the two
// leading corners the 32 px player footprint is sampled at, so the player
// walked into the drawn rock and caught on it ("glued"). 28 was tried and
// sealed a Blackfen Sinks pocket behind a rock beside a wall -- the wall-lane
// test below pins that a rock next to a wall stays passable.
//
// Positions are hand-computed literals on purpose (see the SOMET-344 note in
// authority_collision.test.js): deriving them from DECO_CORE_HALF would make
// them agree with any value, including a wrong one.
const test = require('node:test');
const assert = require('node:assert');
const { ServerMap, resolveMove, DECO_CORE_HALF } = require('../src/authority/collision.js');

// A ServerMap over one 8x8 chunk (grass, plus `wallCol` as water) with the
// given blocking cells. The chunk grid and the decoration overlay are seeded
// straight into ServerMap's own memo Maps, so isWalkable runs its real overlay
// code against them.
function mapWithRocks(cells, { wallCol = null } = {}) {
  const m = new ServerMap({
    chunkSize: 8,
    tileTypes: { grass: { walkable: true, speed: 1 }, water: { walkable: false, speed: 1 } },
  });
  m.chunks.set('0,0', Array.from({ length: 8 }, () => Array.from({ length: 8 }, (_, c) => (c === wallCol ? 'water' : 'grass'))));
  const set = new Set(cells.map(([r, c]) => `${r},${c}`));
  set.solid = new Set();
  m.blockedDecoTiles.set('0,0', set);
  return m;
}

function walk(map, actor, dx, dy, steps) {
  const a = { ...actor };
  for (let i = 0; i < steps; i++) {
    const r = resolveMove(map, a, dx, dy, 0.05);
    a.x = r.x; a.y = r.y;
  }
  return a;
}

test('the rock core this file is written against', () => {
  // If this fails the change may be deliberate: re-derive the literals below.
  assert.equal(DECO_CORE_HALF, 17);
});

test('a blocking decoration blocks its centre +-17 px and nothing beyond', () => {
  const m = mapWithRocks([[2, 3]]); // tile centre (350, 250)
  for (const [x, y] of [[350, 250], [333, 250], [367, 250], [350, 233], [350, 267], [333, 233]]) {
    assert.equal(m.isWalkable(x, y), false, `(${x},${y}) should be inside the core`);
  }
  for (const [x, y] of [[332, 250], [368, 250], [350, 232], [350, 268], [301, 201]]) {
    assert.equal(m.isWalkable(x, y), true, `(${x},${y}) should be outside the core`);
  }
});

test('a player walking straight at a rock stops at its edge instead of walking into it', () => {
  // Centred on the rock's row: the footprint corners (y 234 / 266) straddled
  // the old 20 px core (y 240..260) and walked straight through it.
  const m = mapWithRocks([[2, 3]]);
  const end = walk(m, { x: 150 - 32, y: 250 - 32, width: 64, height: 64, speed: 200 }, 1, 0, 60);
  const face = end.x + 32 + 16; // centre + footprint half-width
  assert.ok(face < 333, `footprint face ${face} entered the core (x >= 333)`);
  assert.ok(face > 332.9, `stopped short of the core edge: face ${face}`);
});

test('a rock beside a wall leaves a lane the player walks through, hugging the wall', () => {
  // Wall = tile column 2 (x < 300); rock core at x 333..367. Lane 33 px.
  // Pressing south-west holds the footprint against the wall face, which is
  // how a player would take it.
  const m = mapWithRocks([[2, 3]], { wallCol: 2 });
  const end = walk(m, { x: 340 - 32, y: 50 - 32, width: 64, height: 64, speed: 200 }, -1, 1, 80);
  assert.ok(end.y + 32 > 350, `player did not get past the rock: centre y ${end.y + 32}`);
});

test('two neighbouring rocks leave a gap a player and a creature both walk through', () => {
  const m = mapWithRocks([[2, 3], [2, 4]]); // cores x 333..367 and 433..467
  const player = walk(m, { x: 400 - 32, y: 550 - 32, width: 64, height: 64, speed: 200 }, 0, -1, 60);
  assert.ok(player.y + 32 < 150, `player stuck in the gap at centre y ${player.y + 32}`);
  const creature = walk(m, { x: 400 - 24, y: 550 - 24, width: 48, height: 48, speed: 200 }, 0, -1, 60);
  assert.ok(creature.y + 24 < 150, `creature stuck in the gap at centre y ${creature.y + 24}`);
});

test('a monument (solid) cell still blocks its whole tile', () => {
  const m = mapWithRocks([[2, 3]]);
  m.blockedDecoTiles.get('0,0').solid.add('2,3');
  assert.equal(m.isWalkable(301, 201), false);
  assert.equal(m.isWalkable(399, 299), false);
});
