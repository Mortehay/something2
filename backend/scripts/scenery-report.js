#!/usr/bin/env node
// Biome scenery report (biome-scenery spec, Goal 6: "mostly walkable, as an
// overall feel"). For every biome it generates N chunks of a synthetic
// single-biome world and counts what generateChunkDecorations places:
// features, ground cover, blockers, and the blocking share of all placed
// objects. The last line is the overall share across every biome.
//
// A REPORT, not a gate (user decision): the ratio is a feel, the look wins
// over the number, so this always exits 0. A biome whose features are ALL
// blockers is flagged, because that reads as a wall rather than scenery.
//
// READ-ONLY: SELECTs only (loadDecorationDefs, tile_types, biomes), safe to run
// against any database.
//
// Usage:  node scripts/scenery-report.js [--chunks 6] [--seed 12345]

const { Pool } = require('pg');
const { generateChunk, generateChunkDecorations } = require('../src/services/mapService');
const { loadDecorationDefs } = require('../src/services/decorationDefs');
const { loadBiomes } = require('../src/services/biomes');

const CHUNK_SIZE = 32;

function argValue(argv, flag, fallback) {
  const i = argv.indexOf(flag);
  if (i === -1 || i + 1 >= argv.length) return fallback;
  const n = Number(argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// One biome's counts over `chunks` chunks laid out in a row. The world is
// unbounded with no generated roads, so the only carved cells are the global
// path lattice -- the same ones a real unbounded world has.
function measureBiome(biome, tileTypes, defs, chunks, seed) {
  const world = {
    seed, chunkSize: CHUNK_SIZE, tileTypes, biomes: [biome], noGeneratedRoads: true,
  };
  const out = { features: 0, cover: 0, blockers: 0, tiles: 0 };
  for (let cx = 0; cx < chunks; cx++) {
    const tiles = generateChunk(world, cx, 0);
    for (const row of tiles) for (const t of row) if (tileTypes[t] && tileTypes[t].walkable !== false) out.tiles++;
    for (const d of generateChunkDecorations(world, cx, 0, tiles, defs)) {
      if (d.layer === 'cover') out.cover++;
      else out.features++;
      if (d.blocking) out.blockers++;
    }
  }
  return out;
}

const pct = (n, d) => (d > 0 ? `${((100 * n) / d).toFixed(1)}%` : '-');

async function main() {
  const argv = process.argv.slice(2);
  const chunks = argValue(argv, '--chunks', 6);
  const seed = argValue(argv, '--seed', 12345);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const defs = await loadDecorationDefs(pool);
    const tr = await pool.query('SELECT name, walkable, speed FROM tile_types ORDER BY id ASC');
    const tileTypes = {};
    for (const t of tr.rows) tileTypes[t.name] = { walkable: t.walkable, speed: t.speed };
    const names = (await pool.query('SELECT name FROM biomes ORDER BY id ASC')).rows.map((r) => r.name);
    const biomes = await loadBiomes(pool, names);

    const rows = [];
    const total = { features: 0, cover: 0, blockers: 0, tiles: 0 };
    for (const b of biomes) {
      const m = measureBiome(b, tileTypes, defs, chunks, seed);
      for (const k of Object.keys(total)) total[k] += m[k];
      rows.push({
        biome: b.name,
        features: m.features,
        cover: m.cover,
        blockers: m.blockers,
        'blocking share': pct(m.blockers, m.features + m.cover),
        'feat blocking': pct(m.blockers, m.features),
        'obj/tile': m.tiles > 0 ? ((m.features + m.cover) / m.tiles).toFixed(2) : '-',
        note: m.features > 0 && m.blockers === m.features ? 'ALL FEATURES BLOCK' : '',
      });
    }
    console.log(`scenery report: ${chunks} chunks of ${CHUNK_SIZE}x${CHUNK_SIZE} per biome, seed ${seed}`);
    console.table(rows);
    console.log(`overall: features ${total.features}, cover ${total.cover}, blockers ${total.blockers}, `
      + `blocking share ${pct(total.blockers, total.features + total.cover)}, `
      + `objects per walkable tile ${(total.tiles > 0 ? (total.features + total.cover) / total.tiles : 0).toFixed(2)}`);
  } catch (err) {
    // Still a report: say what went wrong, do not fail a pipeline over it.
    console.error('scenery-report:', err.message);
  } finally {
    await pool.end().catch(() => {});
  }
  process.exitCode = 0;
}

main();
