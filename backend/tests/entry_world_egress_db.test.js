const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { generateChunk, generateChunkDecorations } = require('../src/services/mapService');
const { buildWorldGenConfig } = require('../src/services/worldGenConfig');
const { loadTileTypes } = require('../src/services/tileTypes');
const { loadBiomes } = require('../src/services/biomes');
const { fetchVillages } = require('../src/services/villages');
const { fetchLinks } = require('../src/services/mapLinks');
const { loadDecorationDefs } = require('../src/services/decorationDefs');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

// SOMET-339. THE POINT OF THIS FILE: a player must be able to walk out of
// wherever they spawn.
//
// Entry-world egress has now broken three times -- twice through spawn
// coordinates (SOMET-335 and the migrations it superseded) and once through
// decorations sealing the village gate, which left a new character with nine
// reachable tiles. Every previous repair was a coordinate fix with nothing
// asserting the outcome, so the next change re-broke it silently and a human
// found it by walking into a wall. This asserts the OUTCOME -- can the player
// leave? -- rather than any particular cause, so it keeps catching the class
// however the next break happens.
//
// It generates from the LIVE world rows rather than a fixture on purpose:
// terrain and decorations are both functions of (seed, size), so a fixture
// would prove something about a world nobody plays.

// Which worlds to check comes from the checked-in specs, NOT from
// `WHERE is_entry = true`. Several DB-backed suites in this repo create
// throwaway `zzTest*` worlds and flip `is_entry` onto them, so that query
// would intermittently measure a 16x16 fixture and prove nothing. The specs
// are the source of truth for which worlds a player can start in, and no
// concurrently-running test can perturb them.
function specEntryWorldNames() {
  const dir = path.join(__dirname, '..', 'seeds', 'maps');
  const names = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.map.json'))) {
    const spec = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    for (const w of spec.worlds || []) if (w.is_entry) names.push(w.name);
  }
  return names;
}

// Walkable per terrain AND clear of blocking decorations -- the same two
// conditions the running game applies, so "reachable" here means reachable in
// play, not merely on the terrain grid.
function buildPassability(cfg, decorationDefs) {
  const N = cfg.chunkSize;
  const chunksX = Math.ceil(cfg.width / N);
  const chunksY = Math.ceil(cfg.height / N);
  const passable = [];
  for (let r = 0; r < cfg.height; r++) passable.push(new Array(cfg.width).fill(false));

  for (let cy = 0; cy < chunksY; cy++) {
    for (let cx = 0; cx < chunksX; cx++) {
      const tiles = generateChunk(cfg, cx, cy);
      for (let r = 0; r < N; r++) {
        for (let c = 0; c < N; c++) {
          const gRow = cy * N + r, gCol = cx * N + c;
          if (gRow >= cfg.height || gCol >= cfg.width) continue;
          const t = cfg.tileTypes[tiles[r][c]];
          passable[gRow][gCol] = !!(t && t.walkable);
        }
      }
      for (const d of generateChunkDecorations(cfg, cx, cy, tiles, decorationDefs)) {
        if (!d.blocking) continue;
        const gRow = cy * N + d.row, gCol = cx * N + d.col;
        if (gRow >= cfg.height || gCol >= cfg.width) continue;
        passable[gRow][gCol] = false;
      }
    }
  }
  return passable;
}

function floodFrom(passable, startRow, startCol, height, width) {
  const seen = new Set();
  const stack = [[startRow, startCol]];
  let touchesBorder = false;
  while (stack.length) {
    const [r, c] = stack.pop();
    if (r < 0 || c < 0 || r >= height || c >= width) continue;
    const key = `${r},${c}`;
    if (seen.has(key) || !passable[r][c]) continue;
    seen.add(key);
    if (r === 0 || c === 0 || r === height - 1 || c === width - 1) touchesBorder = true;
    stack.push([r + 1, c], [r - 1, c], [r, c + 1], [r, c - 1]);
  }
  return { reachable: seen.size, touchesBorder };
}

// NOTE: do not pass this through worldConfig() to "normalise" it. That function
// returns a NEW object which deliberately omits tileTypes, so
// worldConfig(worldConfig(x)) throws 'tileTypes is empty'. The generators
// normalise internally and want the buildWorldGenConfig shape as-is.
async function configFor(pool, row) {
  const links = await fetchLinks(pool, row.id);
  return buildWorldGenConfig({
    row,
    tileTypes: await loadTileTypes(pool),
    biomes: await loadBiomes(pool, row.biomes),
    villages: await fetchVillages(pool, row.id),
    doorways: links.filter((l) => l.edge !== 'PORTAL').map((l) => l.edge),
  });
}

test('a player can walk out of every entry spawn and reach the map edge', { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const names = specEntryWorldNames();
    const decorationDefs = await loadDecorationDefs(pool);
    let checked = 0;

    for (const name of names) {
      const row = (await pool.query('SELECT * FROM worlds WHERE name = $1', [name])).rows[0];
      if (!row) continue;                        // spec not seeded into this DB
      const sp = row.entry_spawn;
      if (!sp || typeof sp.x !== 'number' || typeof sp.y !== 'number') continue;
      if (!row.width || !row.height) continue;   // unbounded world, no grid to flood

      const cfg = await configFor(pool, row);
      // 100 world px per tile, matching authority/collision.js's MAP_TILE_SIZE.
      const startRow = Math.floor(sp.y / 100);
      const startCol = Math.floor(sp.x / 100);
      const passable = buildPassability(cfg, decorationDefs);

      assert.ok(passable[startRow][startCol],
        `"${row.name}": the entry spawn tile (${startRow},${startCol}) is itself blocked`);

      const { reachable, touchesBorder } = floodFrom(
        passable, startRow, startCol, cfg.height, cfg.width);

      assert.ok(touchesBorder,
        `a player spawning in "${row.name}" at tile (${startRow},${startCol}) cannot reach the map edge — `
        + `only ${reachable} of ${cfg.width * cfg.height} tiles are reachable. The spawn is walled in. `
        + `This is SOMET-339: check the village gate corridor and the blocking decorations around it.`);
      checked += 1;
    }

    // Without this the test passes triumphantly having checked nothing at all,
    // which is exactly how a guard rots.
    assert.ok(checked > 0,
      `no spec-declared entry world was checked (looked for: ${names.join(', ') || 'none'})`);
  } finally {
    await pool.end();
  }
});

test('every village gate in an entry world opens onto walkable ground', { skip: !url }, async () => {
  // Narrower than the flood-fill and it fails with a more specific message:
  // this points straight at the gate rather than "you are stuck somewhere".
  // Both are kept — the flood-fill catches a seal anywhere along the route,
  // this catches the gate itself even when a second exit hides the problem.
  const pool = new Pool({ connectionString: url });
  try {
    const decorationDefs = await loadDecorationDefs(pool);
    let checked = 0;

    for (const name of specEntryWorldNames()) {
      const row = (await pool.query('SELECT * FROM worlds WHERE name = $1', [name])).rows[0];
      if (!row || !row.width || !row.height) continue;
      const cfg = await configFor(pool, row);
      if (!cfg.villages || cfg.villages.length === 0) continue;
      const passable = buildPassability(cfg, decorationDefs);

      for (const v of cfg.villages) {
        if (!v.gateEdge) continue;
        // These mid-row/mid-col expressions must match villageGateCell's.
        const rMax = v.minRow + v.height - 1;
        const cMax = v.minCol + v.width - 1;
        const midCol = v.minCol + Math.floor(v.width / 2);
        const midRow = v.minRow + Math.floor(v.height / 2);
        let outRow = midRow, outCol = midCol;
        if (v.gateEdge === 'E') outCol = cMax + 1;
        else if (v.gateEdge === 'W') outCol = v.minCol - 1;
        else if (v.gateEdge === 'S') outRow = rMax + 1;
        else outRow = v.minRow - 1;
        if (outRow < 0 || outCol < 0 || outRow >= cfg.height || outCol >= cfg.width) continue;

        assert.ok(passable[outRow][outCol],
          `"${row.name}": the village at (${v.minRow},${v.minCol}) has a ${v.gateEdge} gate opening onto `
          + `blocked tile (${outRow},${outCol}) — nothing can enter or leave through it`);
        checked += 1;
      }
    }

    assert.ok(checked > 0, 'no village gate was checked in any spec-declared entry world');
  } finally {
    await pool.end();
  }
});
