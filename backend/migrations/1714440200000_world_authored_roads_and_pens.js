exports.shorthands = undefined;

// Two authored columns the home region needs (SOMET-289).
//
// --- authored_roads -------------------------------------------------------
//
// NOTHING COULD AUTHOR WHERE A ROAD GOES. collectPathCells derives the lattice
// purely from seed / pathCell / pathJitter on a coarse anchor grid, and
// SOMET-288's safe_road_radius only WIDENS whatever that already drew. Measured
// on the live worlds before this column existed: Old Trailhead's derived
// lattice comes no closer than Chebyshev 10 to its own east doorway arrival
// tile, so "a road connecting the villages and the two doorways" was
// unreachable at any radius the map can afford.
//
// An array of POLYLINES in tile coordinates -- [[[row,col],[row,col],...],...]
// -- whose cells collectPathCells unions into its own output. Every consecutive
// pair must be axis-aligned; seeds/mapSpec.js rejects anything else, so the
// cells drawn are exactly the cells between the points named. No interpolation
// and no diagonal rasterisation, because an author who cannot predict the cells
// cannot predict the safe corridor either.
//
// Unioning THERE rather than adding a second road source is the point: that one
// function already feeds both generateRegion (so an authored road is DRAWN, in
// the same path tile the lattice uses) and safeRegion via safeContextFor (so the
// safe corridor follows the authored road by construction). One derivation, the
// same reason VILLAGE_LIMITS is shared rather than restated.
//
// --- pens -----------------------------------------------------------------
//
// Authored rectangles holding skittish low-level wildlife, per spec §2:
// [{ min_row, min_col, width, height, creature_type, count, level }]. Read by
// services/pens.js, which places creatures inside the box with a home anchor.
// snake_case here and in the map spec, camelCase in JS, exactly like safe_rects.
//
// Deliberately NOT part of buildWorldGenConfig: a pen is not terrain and the
// generator has no use for one. Keeping it off the generation config is what
// stops it becoming a third thing the chunk endpoint and the authority have to
// agree about.
//
// --- both -----------------------------------------------------------------
//
// DEFAULT '[]' AND NOT BACKFILLED is the compatibility property, the same
// posture 1714440180000 took for safe_road_radius/safe_rects. With an empty
// authored_roads, collectPathCells returns byte-for-byte the Set it returned
// before this migration, so all 86 existing worlds draw the identical terrain
// and place the identical creatures. A world gains a road or a pen only when a
// map spec says so, in a diff somebody reviewed.
exports.up = (pgm) => {
  pgm.addColumns('worlds', {
    authored_roads: { type: 'jsonb', notNull: true, default: '[]' },
    pens: { type: 'jsonb', notNull: true, default: '[]' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('worlds', ['authored_roads', 'pens']);
};
