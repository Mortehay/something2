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

// SOMET-510. The PORTAL endpoints inside this world, as world-pixel points.
//
// Callers hand this the same `fetchLinks(pool, worldId)` rows they already use
// for `doorways`, so no call site grows a query. A world's own outgoing PORTAL
// rows carry BOTH ends of every portal that touches it, because setPortalLink
// (services/mapLinks.js) writes a mirror row -- the far endpoint is the
// from_x/from_y of the mirror, in the mirror's own world.
//
// Why this is mapped HERE and not read off the row: it feeds
// generateChunkDecorations' blocker exclusion, so the REST /chunk preview and
// the authority's ServerMap must both have it or they place different
// decorations and rubber-band. That is exactly the silent divergence this
// module's header exists to prevent, and decoration_clearance.test.js pins
// every call site by source text the way the authority's SELECT is pinned.
function toPortalPoints(links) {
  if (!Array.isArray(links)) return [];
  const out = [];
  for (const l of links) {
    if (!l || l.edge !== 'PORTAL') continue;
    // `l.from_x == null` FIRST, before Number(): a compass row has NULL
    // coordinates and Number(null) is 0, which Number.isFinite happily accepts.
    // Left to it, a row with a missing coordinate would declare a portal at
    // tile (0,0) and strip the blockers off the map's north-west corner for no
    // reason at all -- a silent, invisible wrong answer.
    if (l.from_x == null || l.from_y == null) continue;
    const x = Number(l.from_x), y = Number(l.from_y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push({ x, y });
  }
  return out;
}

function buildWorldGenConfig({ row, tileTypes, doorways, villages, biomes, links }) {
  return {
    seed: Number(row.seed),
    chunkSize: row.chunk_size,
    tileTypes,
    width: row.width,
    height: row.height,
    doorways: doorways || [],
    villages: villages || [],
    entry_spawn: row.entry_spawn,
    // SOMET-510. A caller that omits `links` gets [], never undefined: a
    // missing mapping must present as "this world has no portals", which is
    // what a world with no PORTAL rows produces anyway.
    portals: toPortalPoints(links),
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
    // Authored roads (SOMET-289). Passed through as-is: unlike safe_rects this
    // is not an object shape needing a snake_case->camelCase conversion, it is
    // an array of [row, col] integer pairs that reads identically in the jsonb
    // column, the map spec and JS. mapService's normalizeAuthoredRoads is the
    // single validator and THROWS -- deliberately not duplicated here, for the
    // same reason toSafeRects leaves element shape to safeRegion.
    //
    // A row read before migration 1714440200000 ran (or a hand-built row in a
    // test) must come out opted OUT, never undefined: worlds.pens is NOT mapped
    // here at all because a pen is not terrain and the generator has no use for
    // one -- services/pens.js reads it straight off the row.
    authoredRoads: Array.isArray(row.authored_roads) ? row.authored_roads : [],
  };
}

module.exports = { buildWorldGenConfig };
