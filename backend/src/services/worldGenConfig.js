// The ONE place a `worlds` row becomes a generation config.
//
// Two callers must agree exactly: GET /api/worlds/:id/chunk (what the client
// renders and collides against) and the authority's loadWorld (what the server
// collides against). They used to hand-build near-identical object literals
// several hundred lines apart in different files; every field added to one and
// forgotten in the other is a silent client/server divergence -- terrain the
// client draws that the server doesn't have, and rubber-banding. Adding a
// field HERE reaches both by construction.
//
// `biomes` is the resolved record list from services/biomes.js (already in the
// world's declared banding order), not the raw name array off the row.

// snake_case in the `worlds` row (and in the map spec), camelCase from here on.
//
// Element-level SHAPE is deliberately not checked here -- safeRegion.js's
// normalizeSafeRects is the single validator, because a config can reach
// placement without ever passing through this function and a second copy of the
// rules here would be free to drift from it. What this does do is hand that
// validator something it can describe: mapping straight over the array used to
// die on a `null` element as a bare "Cannot read properties of null" TypeError
// thrown one layer BELOW the validator that was hardened against exactly that,
// naming neither the world nor the column (SOMET-288 review, finding 4).
function toSafeRects(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`worlds.safe_rects must be a jsonb array (got ${typeof raw})`);
  }
  return raw.map((s) => (s && typeof s === 'object'
    ? { minRow: s.min_row, minCol: s.min_col, width: s.width, height: s.height }
    : s));
}

function buildWorldGenConfig({ row, tileTypes, doorways, villages, biomes }) {
  return {
    seed: Number(row.seed),
    chunkSize: row.chunk_size,
    tileTypes,
    width: row.width,
    height: row.height,
    doorways: doorways || [],
    villages: villages || [],
    entry_spawn: row.entry_spawn,
    biomes: biomes || [],
    // null (not undefined) so worldConfig's derive-from-bounds branch runs.
    biomeCell: Number.isFinite(row.biome_cell) ? row.biome_cell : null,
    // Read by both placeMapCreatures and placeCreaturePacks (mapService.js)
    // to roll a creature's level via rollCreatureLevel. A row missing either
    // column (or this mapping) reaches that call as `undefined`, which
    // rollCreatureLevel treats as "no band" and silently rolls level 1 for
    // every creature -- exactly the silent-divergence failure mode this
    // module's header comment warns about.
    levelMin: row.level_min,
    levelMax: row.level_max,
    // Safe territory (SOMET-288). Read by creatureTileCandidates via
    // safeRegion.js, so a hostile is never generated on a road or in a
    // village. snake_case in the DB and the map spec, camelCase from here on,
    // converted in ONE place so no consumer has to know both spellings.
    //
    // Defaults matter: a row read before migration 1714440180000 ran (or a
    // hand-built row in a test) must come out opted OUT, never undefined --
    // undefined would reach worldConfig and normalize to the same thing, but
    // a missing mapping here is precisely the silent divergence this module's
    // header exists to prevent.
    safeRoadRadius: Number(row.safe_road_radius) || 0,
    safeRects: toSafeRects(row.safe_rects),
  };
}

module.exports = { buildWorldGenConfig };
