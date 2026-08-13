// Is this tile inside safe territory? (SOMET-288, Home Region slice A.)
//
// ONE question, asked at SPAWN TIME ONLY. mapService's creatureTileCandidates
// refuses any tile this module calls safe, so no hostile is ever GENERATED in a
// village, on a road, or inside an authored safe rectangle -- and because that
// function is the single chokepoint placeMapCreatures and placeCreaturePacks
// both pass through, seeding and the admin re-roll route inherit the rule
// without either of them naming it.
//
// NOTHING ON THE MOVEMENT OR TICK PATH MAY CALL THIS. A hostile that is already
// chasing a player MUST be able to follow them onto the road and through the
// village gate -- that is the moment the gate guards exist for (SOMET-291), and
// a barrier here would turn the rescue into an invisible wall. Safety in this
// game is earned, not enforced.
//
// Deliberately imports NOTHING. mapService requires this module, so a require
// back into mapService would be a cycle, and whichever of the two loaded second
// would see a half-built exports object. The road cells are therefore passed IN
// -- as collectPathCells' own Set of "row,col" keys -- rather than recomputed
// here. That is also the SOMET-282 / VILLAGE_LIMITS reason: one derivation of
// where the roads are, shared, instead of two that can drift.

// Inclusive box test in tile coordinates. Shared by villages and authored
// rectangles because they are the same shape and the same question; a village's
// WALL RING counts as inside, which is what we want -- a hostile spawned on a
// wall tile would be stuck inside geometry.
//
// Exported (not just used internally) because mapService.js's
// pointInVillageBox was a byte-for-byte duplicate of this same box test --
// this repo already carries one duplicated geometry routine (resolveMove) as
// a standing hazard, and a second copy is the same trap in a new costume.
// mapService.js re-exports this under its existing name so no call site
// (stampVillage, villageContaining, their tests) has to change.
function inBox(gRow, gCol, b) {
  return gRow >= b.minRow && gRow <= b.minRow + b.height - 1
      && gCol >= b.minCol && gCol <= b.minCol + b.width - 1;
}

// Normalize once, so isSafeTile can be a hot-path predicate that trusts its
// context. A radius that is not a positive integer becomes 0 -- never NaN:
// every comparison against NaN is false, so a junk radius would silently
// disable the road leg in a way no assertion would notice.
function buildSafeContext({ villages, pathCells, safeRoadRadius, safeRects } = {}) {
  return {
    villages: Array.isArray(villages) ? villages : [],
    pathCells: pathCells instanceof Set ? pathCells : new Set(),
    safeRoadRadius: typeof safeRoadRadius === 'number' && Number.isInteger(safeRoadRadius) && safeRoadRadius > 0 ? safeRoadRadius : 0,
    safeRects: Array.isArray(safeRects) ? safeRects : [],
  };
}

// CHEBYSHEV distance, not Euclidean and not Manhattan: a radius-N road is a
// (2N+1)-tile ribbon with square corners. "Within N tiles" has three defensible
// readings, so the one in force is stated here and pinned by the tests.
//
// Radius 0 means roads are not safe AT ALL -- not even the carved cell itself.
// That is the property that keeps every world which has not opted in placing
// byte-for-byte the creatures it placed before this module existed.
//
// Scanned rather than pre-dilated: authored radii are small (single digits), so
// this is at most a few dozen Set lookups, and it keeps the context free of any
// allocation policy that would have to be tuned per map size.
function nearPathCell(ctx, gRow, gCol) {
  const r = ctx.safeRoadRadius;
  if (r <= 0 || ctx.pathCells.size === 0) return false;
  for (let dr = -r; dr <= r; dr++) {
    for (let dc = -r; dc <= r; dc++) {
      if (ctx.pathCells.has(`${gRow + dr},${gCol + dc}`)) return true;
    }
  }
  return false;
}

// Villages first, rectangles second, roads last: the first two are O(count) with
// counts in the single digits, the third is the only one that scans.
function isSafeTile(ctx, gRow, gCol) {
  for (const v of ctx.villages) if (inBox(gRow, gCol, v)) return true;
  for (const s of ctx.safeRects) if (inBox(gRow, gCol, s)) return true;
  return nearPathCell(ctx, gRow, gCol);
}

module.exports = { buildSafeContext, isSafeTile, inBox };
