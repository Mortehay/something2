#!/usr/bin/env node
// SOMET-366. Does any live world have a doorway, portal or village gate that a
// player cannot walk away from once BLOCKING DECORATIONS are counted?
//
// Why this is not the same question assertNavigable asks. That check flood-fills
// TERRAIN only: it reads world.tileTypes[grid[r][c]].walkable and nothing else.
// Blocking decorations (Stone / Tree / IceRock / ...) are real collision at
// runtime -- authority/collision.js ServerMap.isWalkable consults the same
// generateChunkDecorations overlay -- but they are invisible to seeding. So a
// world can seed clean and still drop an arriving player into a pocket.
//
// READ-ONLY. It opens a pool, SELECTs, and generates in memory. It writes
// nothing, which is the whole point: it must be safe to run against the shared
// dev database at any time.
//
// Usage:  node scripts/scan-decoration-seals.js [--json] [--world <name>]

const { Pool } = require('pg');
const {
  worldConfig, generateRegion, generateChunkDecorations,
} = require('../src/services/mapService');
const { buildWorldGenConfig } = require('../src/services/worldGenConfig');
const { loadDecorationDefs } = require('../src/services/decorationDefs');
const { loadBiomes } = require('../src/services/biomes');
const { fetchVillages } = require('../src/services/villages');

const MAP_TILE_SIZE = 100;

// Build the walkability grid a PLAYER actually meets: terrain, minus every
// blocking decoration the runtime would generate over it. Deliberately built
// from the same two functions the authority uses, not a reimplementation --
// a scan that models placement its own way would find its own bugs, not the
// game's.
function buildWalkGrid(world, tileTypes, decorationDefs) {
  const cfg = worldConfig(world);
  const { width, height } = cfg.bounds;
  const grid = generateRegion(world, 0, 0, height, width);

  const walk = [];
  for (let r = 0; r < height; r++) {
    const row = new Uint8Array(width);
    for (let c = 0; c < width; c++) {
      const def = tileTypes[grid[r][c]];
      row[c] = def && def.walkable === false ? 0 : 1;
    }
    walk.push(row);
  }

  // Decorations are generated per chunk, so walk the chunks that cover the map.
  const N = cfg.chunkSize;
  let blockers = 0;
  for (let cy = 0; cy * N < height; cy++) {
    for (let cx = 0; cx * N < width; cx++) {
      const tiles = generateRegion(world, cy * N, cx * N, N, N);
      for (const d of generateChunkDecorations(world, cx, cy, tiles, decorationDefs)) {
        if (!d.blocking) continue;
        const gRow = cy * N + d.row, gCol = cx * N + d.col;
        if (gRow < 0 || gRow >= height || gCol < 0 || gCol >= width) continue;
        if (walk[gRow][gCol] === 1) { walk[gRow][gCol] = 0; blockers++; }
      }
    }
  }
  return { walk, width, height, blockers, terrain: grid };
}

function floodFrom(walk, width, height, startRow, startCol) {
  const seen = new Set();
  if (startRow < 0 || startRow >= height || startCol < 0 || startCol >= width) return seen;
  if (!walk[startRow][startCol]) return seen;
  const queue = [[startRow, startCol]];
  seen.add(`${startRow},${startCol}`);
  while (queue.length) {
    const [r, c] = queue.pop();
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= height || nc < 0 || nc >= width) continue;
      const key = `${nr},${nc}`;
      if (seen.has(key) || !walk[nr][nc]) continue;
      seen.add(key);
      queue.push([nr, nc]);
    }
  }
  return seen;
}

// Every point a player can ARRIVE at, and therefore must be able to leave.
// Mirrors seed-map.js's requiredTilesFor, but sourced from the live DB rather
// than a spec file, so it covers worlds seeded from any spec.
function arrivalPoints(row, doorways, portalRows, villages) {
  const midRow = Math.floor(row.height / 2), midCol = Math.floor(row.width / 2);
  const out = [];
  for (const e of doorways) {
    if (e === 'N') out.push({ row: 1, col: midCol, what: 'arrival via doorway N' });
    if (e === 'S') out.push({ row: row.height - 2, col: midCol, what: 'arrival via doorway S' });
    if (e === 'W') out.push({ row: midRow, col: 1, what: 'arrival via doorway W' });
    if (e === 'E') out.push({ row: midRow, col: row.width - 2, what: 'arrival via doorway E' });
  }
  for (const l of portalRows) {
    if (l.from_world_id === row.id) {
      out.push({
        row: Math.floor(l.from_y / MAP_TILE_SIZE), col: Math.floor(l.from_x / MAP_TILE_SIZE),
        what: 'portal source',
      });
    }
    if (l.to_world_id === row.id) {
      out.push({
        row: Math.floor(l.to_y / MAP_TILE_SIZE), col: Math.floor(l.to_x / MAP_TILE_SIZE),
        what: 'portal arrival',
      });
    }
  }
  for (const v of villages || []) {
    if (Number.isFinite(v.spawnX) && Number.isFinite(v.spawnY)) {
      out.push({
        row: Math.floor(v.spawnY / MAP_TILE_SIZE), col: Math.floor(v.spawnX / MAP_TILE_SIZE),
        what: `village spawn (${v.name || v.id})`,
      });
    }
  }
  if (row.entry_spawn && Number.isFinite(row.entry_spawn.x)) {
    out.push({
      row: Math.floor(row.entry_spawn.y / MAP_TILE_SIZE),
      col: Math.floor(row.entry_spawn.x / MAP_TILE_SIZE),
      what: 'entry spawn',
    });
  }
  return out;
}

// A pocket is what makes this a player-visible trap rather than a cosmetic
// nuisance: the arrival tile is walkable, but almost nothing is reachable from
// it. Reported as an absolute cell count because that is the number a human can
// picture ("you land in four cells").
const POCKET_CELLS = 64;

async function scanWorld(pool, row, decorationDefs) {
  const tr = await pool.query('SELECT name, walkable, speed FROM tile_types ORDER BY id ASC');
  const tileTypes = {};
  for (const t of tr.rows) tileTypes[t.name] = { walkable: t.walkable, speed: t.speed };

  const linkRows = (await pool.query(
    `SELECT edge, from_world_id, to_world_id, from_x, from_y, to_x, to_y
       FROM map_links WHERE from_world_id = $1 OR to_world_id = $1`, [row.id])).rows;
  const doorways = linkRows.filter((l) => l.edge !== 'PORTAL' && l.from_world_id === row.id).map((l) => l.edge);
  const portalRows = linkRows.filter((l) => l.edge === 'PORTAL');
  const villages = await fetchVillages(pool, row.id);
  const biomes = await loadBiomes(pool, row.biomes);
  const world = buildWorldGenConfig({ row, tileTypes, doorways, villages, biomes });

  const { walk, width, height, blockers } = buildWalkGrid(world, tileTypes, decorationDefs);
  const points = arrivalPoints(row, doorways, portalRows, villages);
  const findings = [];
  for (const p of points) {
    if (p.row < 0 || p.row >= height || p.col < 0 || p.col >= width) continue;
    if (!walk[p.row][p.col]) {
      findings.push({ ...p, kind: 'sealed', reachable: 0 });
      continue;
    }
    const reach = floodFrom(walk, width, height, p.row, p.col);
    if (reach.size <= POCKET_CELLS) {
      findings.push({ ...p, kind: 'pocket', reachable: reach.size });
    }
  }
  return { world: row.name, id: row.id, width, height, blockers, points: points.length, findings };
}

async function main() {
  const json = process.argv.includes('--json');
  const only = process.argv.includes('--world') ? process.argv[process.argv.indexOf('--world') + 1] : null;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const decorationDefs = await loadDecorationDefs(pool);
    const { rows } = await pool.query(
      `SELECT * FROM worlds
        WHERE width IS NOT NULL AND height IS NOT NULL
          ${only ? 'AND name = $1' : ''}
        ORDER BY name ASC`, only ? [only] : []);

    const results = [];
    for (const row of rows) results.push(await scanWorld(pool, row, decorationDefs));

    if (json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      let bad = 0;
      for (const r of results) {
        if (!r.findings.length) continue;
        bad++;
        console.log(`\n${r.world}  (${r.width}x${r.height}, ${r.blockers} blocking decorations)`);
        for (const f of r.findings) {
          console.log(`  ${f.kind.toUpperCase().padEnd(6)} ${f.what} at (${f.row},${f.col}) -- ${f.reachable} cells reachable`);
        }
      }
      console.log(`\n${bad} of ${results.length} worlds have a decoration-sealed arrival point.`);
    }
    process.exitCode = results.some((r) => r.findings.length) ? 1 : 0;
  } finally {
    await pool.end();
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(2); });

module.exports = { buildWalkGrid, floodFrom, arrivalPoints, POCKET_CELLS };
