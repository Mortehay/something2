// backend/tests/villageSpawnInterior.test.js
//
// SOMET-153. Three seeded villages placed their spawn/respawn point on the
// village WALL RING, so respawn-at-village teleported the player inside the
// wall. The regression test that matters is the first one below: it does not
// re-implement the geometry rule, it STAMPS the village exactly the way the
// live map generator does and then looks at the tile the spawn pixel actually
// lands on. A rule-vs-rule test would have agreed with itself and passed on
// the broken data.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { stampVillage } = require('../src/services/mapService');
const { villageGeometryError } = require('../src/services/villages');
const { validateMapSpec } = require('../seeds/mapSpec');

const TILE = 100;                       // MAP_TILE_SIZE (authority/collision.js)
const MAPS_DIR = path.join(__dirname, '..', 'seeds', 'maps');

function specFiles() {
  return fs.readdirSync(MAPS_DIR).filter((f) => f.endsWith('.map.json'));
}

// Every authored village across every checked-in spec, tagged with enough
// context for a failure message to name the offender.
function authoredVillages() {
  const out = [];
  for (const file of specFiles()) {
    const spec = JSON.parse(fs.readFileSync(path.join(MAPS_DIR, file), 'utf8'));
    for (const w of spec.worlds ?? []) {
      if (w.village) out.push({ file, key: w.key, name: w.name, v: w.village });
    }
  }
  return out;
}

// The tile the spawn pixel lands on, AFTER stampVillage has painted the box.
// Window is the box plus a one-tile margin, so a spawn that has escaped the
// box entirely is visible as such instead of throwing an index error.
function stampedSpawnTile(v) {
  const rMin = v.min_row - 1;
  const cMin = v.min_col - 1;
  const rows = v.height + 2;
  const cols = v.width + 2;
  const grid = Array.from({ length: rows }, () => Array(cols).fill('grass'));
  stampVillage(grid, rMin, cMin, rows, cols, {
    minRow: v.min_row,
    minCol: v.min_col,
    width: v.width,
    height: v.height,
    gateEdge: v.gate_edge,
    wallTile: 'wooden_wall',
    gateTile: 'village_gate',
  });
  const sCol = Math.floor(v.spawn_x / TILE);
  const sRow = Math.floor(v.spawn_y / TILE);
  const r = sRow - rMin;
  const c = sCol - cMin;
  const tile = (r >= 0 && r < rows && c >= 0 && c < cols) ? grid[r][c] : 'OUTSIDE_BOX';
  return { sRow, sCol, tile };
}

test('every authored village spawns on a tile stampVillage leaves walkable', () => {
  const villages = authoredVillages();
  assert.ok(villages.length > 0, 'no authored villages found — the test is not exercising anything');

  for (const { file, key, name, v } of villages) {
    const { sRow, sCol, tile } = stampedSpawnTile(v);
    assert.equal(
      tile, 'grass',
      `${file} world "${key}" (${name}): spawn (${v.spawn_x},${v.spawn_y}) lands on tile `
      + `(row ${sRow}, col ${sCol}) which stampVillage paints as "${tile}" — a player respawning `
      + `here is inside the village wall`,
    );
  }
});

// SOMET-282 note for every fixture below: the shape that originally shipped
// broken was 6x5, and villageGeometryError now ALSO enforces the on-screen size
// budget (width + height <= 10 tiles) and reports that FIRST. A 6x5 fixture
// would therefore be rejected for its size and never reach the spawn rule,
// which would quietly stop testing the spawn rule at all. Every box here is
// 6x4 — the size the three hubs were shrunk to — with the spawn moved onto the
// corresponding ring/interior tile of that box. Box rows 28..31, cols 28..33;
// gate S at (row 31, col 31); interior rows 29..30, cols 29..32.
test('the seed-spec validator rejects a village spawning on the wall ring', () => {
  const spec = {
    worlds: [{
      key: 'hub', name: 'Hub', grid: [0, 0], width: 64, height: 64, is_entry: true,
      village: {
        key: 'hub-village',
        min_row: 28, min_col: 28, width: 6, height: 4, gate_edge: 'S',
        spawn_x: 3250, spawn_y: 3150,   // tile (row 31, col 32) = south wall
      },
    }],
    links: [],
  };
  const errors = validateMapSpec(spec);
  const spawnErrors = errors.filter((e) => e.includes('village interior'));
  assert.equal(spawnErrors.length, 1, `expected one spawn error, got ${JSON.stringify(errors)}`);
  assert.match(spawnErrors[0], /world "hub"/);
  assert.match(spawnErrors[0], /3250,3150/);
  assert.match(spawnErrors[0], /row 31, col 32/);
});

test('the seed-spec validator accepts the corrected interior spawn', () => {
  const spec = {
    worlds: [{
      key: 'hub', name: 'Hub', grid: [0, 0], width: 64, height: 64, is_entry: true,
      village: {
        key: 'hub-village',
        min_row: 28, min_col: 28, width: 6, height: 4, gate_edge: 'S',
        spawn_x: 3050, spawn_y: 2950,
      },
      // `hub` is the entry world, so SOMET-335 requires entry_spawn to BE the
      // village spawn. This assertion is deepEqual-against-[], so an unrelated
      // second error would break it -- and the corrected interior spawn is
      // exactly what entry_spawn has to point at.
      entry_spawn: { x: 3050, y: 2950 },
    }],
    links: [],
  };
  assert.deepEqual(validateMapSpec(spec), []);
});

test('villageGeometryError flags each wall ring edge and the tile outside the box', () => {
  const box = { min_row: 28, min_col: 28, width: 6, height: 4, gate_edge: 'S' };
  const onRing = [
    ['north wall', 2850, 2850],   // row 28
    ['south wall', 3250, 3150],   // row 31
    ['west wall', 2850, 3050],    // col 28
    ['east wall', 3350, 3050],    // col 33
    ['outside the box', 100, 100],
  ];
  for (const [label, x, y] of onRing) {
    assert.ok(
      villageGeometryError({ ...box, spawn_x: x, spawn_y: y }),
      `${label} (${x},${y}) should be rejected`,
    );
  }
  // Every interior tile is accepted: rows 29..30, cols 29..32.
  for (let r = 29; r <= 30; r++) {
    for (let c = 29; c <= 32; c++) {
      assert.equal(
        villageGeometryError({ ...box, spawn_x: c * TILE + 50, spawn_y: r * TILE + 50 }), null,
        `interior tile (row ${r}, col ${c}) should be accepted`,
      );
    }
  }
});

test('villageGeometryError requires finite spawn coordinates', () => {
  const box = { min_row: 28, min_col: 28, width: 6, height: 4, gate_edge: 'S' };
  assert.match(villageGeometryError({ ...box }), /required/);
  assert.match(villageGeometryError({ ...box, spawn_x: '3050', spawn_y: 2950 }), /required/);
});
