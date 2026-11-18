// SOMET-773: give a world its ruins, or keep the ones it has.
//
// ensureStructures loads everything the generator must respect from the
// database -- the world row, its links, villages, biomes, tile types, the
// decoration catalog, and every persisted thing standing on the map -- and
// writes the result to worlds.structures. Idempotent: a world whose stored
// ruins are still valid is left byte-identical and its chunk cache untouched.
//
// Stored `auto` ruins are re-validated every run, because seed-map can change
// a world's seed/size/biomes under them: a ruin whose footprint is no longer
// in bounds and walkable is dropped, and if the kept set no longer passes the
// navigability check they are all re-rolled. Anything else (`source: 'spec'`,
// SOMET-775) is the author's and is kept as written.
const { buildWorldGenConfig } = require('./worldGenConfig');
const { generateRegion } = require('./mapService');
const { assertNavigable } = require('./navigability');
const { generateStructureSites } = require('./structureSites');
const { loadTileTypes } = require('./tileTypes');
const { loadBiomes } = require('./biomes');
const { fetchVillages } = require('./villages');
const { fetchLinks } = require('./mapLinks');
const { loadDecorationDefs } = require('./decorationDefs');
const { arrivalPoints } = require('../../scripts/scan-decoration-seals.js');
const { STRUCTURE_TYPES } = require('../../seeds/data/structureTypes.js');

const T = 100;
const tile = (x, y) => ({ row: Math.floor(Number(y) / T), col: Math.floor(Number(x) / T) });

function eligible(row) {
  if (!row || !row.width || !row.height) return false;
  const name = String(row.name || '');
  return !/^Boss Arena:/.test(name) && !/: Hub$/.test(name);
}

async function pointsOf(db, sql, worldId) {
  const { rows } = await db.query(sql, [worldId]);
  return rows.filter((r) => Number.isFinite(Number(r.x)) && Number.isFinite(Number(r.y))).map((r) => tile(r.x, r.y));
}

// What the generator must keep reachable (required) and stand clear of (avoid).
async function constraintsFor(db, row, links, villages) {
  const doorways = links.filter((l) => l.edge !== 'PORTAL').map((l) => l.edge);
  // Both ends that land in THIS world: portals leaving it and portals arriving
  // from elsewhere (fetchLinks only returns the outgoing rows, without ids).
  const { rows: portals } = await db.query(
    `SELECT from_world_id, to_world_id, from_x, from_y, to_x, to_y FROM map_links
      WHERE edge = 'PORTAL' AND (from_world_id = $1 OR to_world_id = $1)`, [row.id]);
  const required = arrivalPoints(row, doorways, portals, villages);
  for (const p of await pointsOf(db, 'SELECT x, y FROM world_chests WHERE world_id = $1', row.id)) required.push({ ...p, what: 'chest' });
  for (const p of await pointsOf(db, 'SELECT x, y FROM waypoints WHERE world_id = $1', row.id)) required.push({ ...p, what: 'waypoint' });
  const avoid = [];
  for (const p of await pointsOf(db, 'SELECT x, y FROM world_creatures WHERE world_id = $1', row.id)) avoid.push({ ...p, radius: 0 });
  for (const p of await pointsOf(db, 'SELECT x, y FROM world_items WHERE world_id = $1', row.id)) avoid.push({ ...p, radius: 0 });
  for (const p of await pointsOf(db, 'SELECT x, y FROM creature_respawns WHERE world_id = $1', row.id)) avoid.push({ ...p, radius: 0 });
  for (const p of await pointsOf(db, 'SELECT x, y FROM world_players WHERE world_id = $1', row.id)) avoid.push({ ...p, radius: 2 });
  for (const p of await pointsOf(db, 'SELECT x, y FROM player_binds WHERE world_id = $1', row.id)) avoid.push({ ...p, radius: 2 });
  return { required, avoid, doorways };
}

// Stored auto ruins that still stand on in-bounds walkable ground. Judged on
// the world WITHOUT any ruins, so a ruin is never "valid" because of itself.
function stillValid(world, sites) {
  const bare = { ...world, structures: [] };
  const { width, height } = world;
  const terrain = generateRegion(bare, 0, 0, height, width);
  const tt = world.tileTypes || {};
  return sites.filter((s) => {
    for (let r = s.minRow; r < s.minRow + s.height; r++) {
      for (let c = s.minCol; c < s.minCol + s.width; c++) {
        if (r < 1 || c < 1 || r >= height - 1 || c >= width - 1) return false;
        const d = tt[terrain[r][c]];
        if (d && d.walkable === false) return false;
      }
    }
    return true;
  });
}

async function ensureStructures(db, worldId, { decorationDefs = null, regenerate = false, styles = STRUCTURE_TYPES } = {}) {
  const { rows: [row] } = await db.query('SELECT * FROM worlds WHERE id = $1', [worldId]);
  if (!row) throw new Error(`ensureStructures: no world ${worldId}`);
  const stored = Array.isArray(row.structures) ? row.structures : [];
  if (!eligible(row)) return { world: row.name, skipped: true, kept: stored.length, added: 0, dropped: 0, changed: false };

  const [tileTypes, links, villages, biomes, defs] = await Promise.all([
    loadTileTypes(db), fetchLinks(db, worldId), fetchVillages(db, worldId), loadBiomes(db, row.biomes),
    decorationDefs ? Promise.resolve(decorationDefs) : loadDecorationDefs(db),
  ]);
  const { required, avoid, doorways } = await constraintsFor(db, row, links, villages);
  const world = buildWorldGenConfig({ row, tileTypes, doorways, villages, biomes, links });

  const authored = stored.filter((s) => s.source !== 'auto');
  const auto = regenerate ? [] : stored.filter((s) => s.source === 'auto');
  let keep = [...authored, ...stillValid(world, auto)];
  // A kept set that no longer passes the check (terrain moved around it) is
  // re-rolled whole rather than patched: partial survivors cannot be trusted.
  const interiors = keep.map((s) => ({ row: s.minRow + 1, col: s.minCol + 1, what: `ruin ${s.type} interior` }));
  if (keep.length && assertNavigable({ ...world, structures: keep, noGeneratedRoads: true },
    [...required, ...interiors], { decorationDefs: defs }).length) {
    keep = [...authored];
  }
  const next = generateStructureSites(world, { styles, decorationDefs: defs, required, avoid, keep });
  const changed = JSON.stringify(next) !== JSON.stringify(stored);
  if (changed) {
    await db.query('UPDATE worlds SET structures = $1::jsonb WHERE id = $2', [JSON.stringify(next), worldId]);
    // Cached chunks hold the old ground. The authority's in-memory copy does
    // too -- a running backend must be restarted (or the world evicted).
    await db.query('DELETE FROM world_chunks WHERE world_id = $1', [worldId]);
  }
  const keptAuto = keep.filter((s) => s.source === 'auto').length;
  return {
    world: row.name, skipped: false, changed,
    kept: keep.length, added: next.length - keep.length, dropped: regenerate ? 0 : auto.length - keptAuto,
  };
}

module.exports = { ensureStructures, eligible };
