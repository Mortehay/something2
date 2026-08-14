// Validation for map specs. Pure: no database, no I/O, so the whole rule set is
// unit-testable. The applier refuses to write anything when this returns a
// non-empty array.
//
// WHY THE GRID EXISTS: map_links declares UNIQUE(from_world_id, edge) over
// edge IN ('N','E','S','W'), and setLink writes the mirror edge automatically.
// So a world has at most four neighbours and an adventure map must embed in a
// 2D grid. Checking every link against that grid here is what makes a seeded
// map geometrically consistent -- and it is the same grid that seeds
// graph_x/graph_y, so the World Map tab cannot draw it contradicting its links.
//
// N is -y: edgeOfDoorwayTile (services/mapService.js:724) defines N as
// gRow === 0, the top row.
//
// This object must stay byte-identical to STEP in
// frontend/src/games/something2/mapGraphLayout.js:10, which lays out the
// World Map tab's Cytoscape graph from the same grid coordinates. That file
// is the likelier drift target day to day (it's touched for layout/UI work,
// this file only for seeding) even though edgeOfDoorwayTile is the deeper
// source of truth for the convention.
const EDGE_DELTA = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };

// Single source of truth for village size limits, also imported by
// validateVillageBody in src/index.js. Imported (not duplicated) here so a
// spec that passes this validator can never then be rejected by the API's
// own village-bounds check -- the two callers would otherwise be free to
// drift apart. mapService.js and merchantStock.js (villages.js's own
// requires) have no top-level DB/pool creation, so this stays a pure,
// database-free require.
const { VILLAGE_LIMITS, villageGeometryError } = require('../src/services/villages.js');

const { DENSITY_NAMES } = require('../src/services/densityTiers.js');

// Pen geometry, imported for the same cannot-drift-apart reason
// VILLAGE_LIMITS/villageGeometryError are: the placer that seats pen creatures
// and the validator that accepts a pen must agree about what fits, or a spec
// validates and then seeds a pen that quietly holds fewer creatures than it
// says. services/pens.js's own requires (mapService, creatureLevel, and
// villages.js for the one GUARD_TYPE literal -- already imported above) create
// no pool at import time, so this stays a pure, database-free require.
const { penGeometryError } = require('../src/services/pens.js');

// True only when w.grid is a well-formed [int, int] pair. Shared by the
// world loop (which reports the error) and the link loop (which must not
// dereference grid[0]/grid[1] on a world that failed this check -- a link
// naming a world with a missing/null/malformed grid must produce an error,
// not throw).
function hasValidGrid(w) {
  return Array.isArray(w.grid) && w.grid.length === 2
      && Number.isInteger(w.grid[0]) && Number.isInteger(w.grid[1]);
}

// The singular `village` key and the plural `villages` array read as one list.
// Both the validator and scripts/seed-map.js call THIS -- the same
// cannot-drift-apart reason VILLAGE_LIMITS is shared rather than restated. 20+
// checked-in specs use the singular form and none of them should have to change
// for a world elsewhere to want three villages.
function villagesOf(w) {
  if (Array.isArray(w.villages)) return w.villages;
  return w.village ? [w.village] : [];
}

function boxesOverlap(a, b) {
  return a.min_row <= b.min_row + b.height - 1
      && b.min_row <= a.min_row + a.height - 1
      && a.min_col <= b.min_col + b.width - 1
      && b.min_col <= a.min_col + a.width - 1;
}

// Widest safe corridor a spec is allowed to ask for -- a BACKSTOP against an
// absurd value, matching the DB's CHECK constraint, not authoring guidance.
// Chebyshev dilation saturates fast against the real generator (default
// pathCell 24, pathJitter 6): a 64-tile world is already ~40% safe at r=2 and
// 92% safe at r=8. See the measured table and recommended range (1-3) in the
// comment above the CHECK constraint in
// migrations/1714440180000_world_safe_region.js.
const MAX_SAFE_ROAD_RADIUS = 8;

// Pixels per map tile. Spec coordinates (portal from_x/from_y, waypoint x/y)
// are pixels; the things they collide with are TILES, because that is the
// granularity a player stands at and the granularity both the authority's tick
// loop and waypoints_world_tile_unique work in.
const SPEC_TILE_SIZE = 100;

// A world-scoped tile identity, used to ask "do these two authored things want
// the same tile?". Deliberately NOT the exact-pixel slot the portal-collision
// check above uses: two portals 1px apart really are a conflict at the database
// level (they share a unique index on exact coordinates), whereas a waypoint
// and a portal 1px apart are a conflict because a player cannot stand on one
// without standing on the other.
//
// ROW FIRST, then column -- the order services/waypoints.js keys the tick loop's
// lookup in, the order assertNavigable reports a tile in, and therefore the
// order the rejection messages below print. The two helpers were transposed
// relative to each other while each stayed internally consistent, which is the
// kind of agreement that holds right up until someone compares one to the other.
function tileSlot(worldKey, x, y) {
  return `${worldKey}:${Math.floor(y / SPEC_TILE_SIZE)},${Math.floor(x / SPEC_TILE_SIZE)}`;
}

// Every key a world object may carry -- anything else is an error, not an
// ignored extra.
//
// An unread key is indistinguishable from a consumed one from the author's
// side: the spec validates, the seed exits 0, and the feature is simply not
// there. `pens:` was the live example -- SOMET-288 shipped the safe-region
// model without a pen reader (see the deferral note in
// docs/superpowers/plans/2026-08-12-home-region-a-safe-region.md), so until
// SOMET-289 landed one, a spec authoring pens would be accepted and silently
// produce nothing. That is the SOMET-153 failure class the singular/plural
// `village` checks above already guard against, one level up.
//
// WORLDS ONLY, deliberately. This is the level authors actually extend (every
// new authored feature so far -- density, level_band, allows_fast_travel,
// safe_road_radius, pens and now waypoints -- landed here), and it is the level
// where a typo'd or premature key costs the most. Links and villages are not
// covered: their shapes are already pinned field-by-field above, and widening
// the rule to them buys little for the extra chance of rejecting a spec over a
// key that some other branch legitimately added -- `is_waypoint` and
// `waypoint_name` are link-level for exactly that reason.
//
// `creature_count` is listed even though it is RETIRED: it has its own,
// far more useful error message a few lines below ("use density instead"), and
// leaving it out here would bury that message under a generic one.
const WORLD_KEYS = new Set([
  'key', 'name', 'grid', 'seed', 'width', 'height', 'chunk_size',
  'biomes', 'biome_cell', 'allowed_creature_types', 'is_entry', 'entry_spawn',
  'level_band', 'density', 'allows_fast_travel',
  'village', 'villages', 'chest',
  'safe_road_radius', 'safe_rects',
  'roads',
  'pens',
  'waypoints',
  'creature_count',
]);

function validateMapSpec(spec, { biomeNames = null, creatureTypeNames = null } = {}) {
  const errors = [];
  if (!spec || typeof spec !== 'object') return ['spec is not an object'];
  const worlds = Array.isArray(spec.worlds) ? spec.worlds : [];
  const links = Array.isArray(spec.links) ? spec.links : [];
  if (worlds.length === 0) return ['spec has no worlds'];

  const byKey = new Map();
  const seenNames = new Set();
  const cells = new Map();

  // A world reachable only through a PORTAL link never embeds in the
  // overworld's 2D grid, so it must not be required to declare one. This
  // scan runs before the per-world loop so that loop can consult it.
  const portalConnectedKeys = new Set();
  // THE LOAD-BEARING WAYPOINT RULE (SOMET-292, home-region spec §5): a portal a
  // creature guards may never be a waypoint. Without it a guarded dungeon
  // entrance is bypassable on the second visit and the level-band gating
  // joinPolicy was written to protect stops holding.
  //
  // BOTH SIDES of a guarded link go in. setPortalLink writes two rows per
  // staircase and insertPortalGuards only ever defends the DEPARTURE side, so
  // making the arrival side a waypoint drops a traveller past the guard --
  // the same bypass, spelled backwards. Recorded per tile so a standalone
  // waypoint authored on the staircase's own tile is caught by the same set.
  //
  // Collected here, before the world loop, for the same reason
  // portalConnectedKeys is: that loop has to consult it.
  // Maps the tile to a description of WHAT guards it, not just to "guarded":
  // the error has to name the guard, or an author faced with a rejection has no
  // way to tell which of a spec's portals it means.
  const guardedStaircaseTiles = new Map();
  for (const l of links) {
    if (l.kind !== 'portal') continue;
    portalConnectedKeys.add(l.from); portalConnectedKeys.add(l.to);
    if (!l.guard) continue;
    const coords = ['from_x', 'from_y', 'to_x', 'to_y'];
    // A malformed coordinate is reported by the link loop below; skipping it
    // here keeps floor(undefined) out of the map (it would produce "NaN,NaN",
    // a slot nothing can match, silently disarming the rule for that link).
    if (coords.some((f) => !Number.isInteger(l[f]))) continue;
    const who = `${l.guard.count ?? '?'}x ${l.guard.creature_type ?? 'unnamed guard'} `
      + `on portal ${l.from}->${l.to}`;
    guardedStaircaseTiles.set(tileSlot(l.from, l.from_x, l.from_y), who);
    guardedStaircaseTiles.set(tileSlot(l.to, l.to_x, l.to_y), `${who} (arrival side)`);
  }

  // Every waypoint name the spec claims, and every tile one occupies. Both are
  // spec-wide: names share one UNIQUE(name) column across every world, and a
  // tile can hold one waypoint because that is all the tick loop can find.
  const waypointNames = new Set();
  const waypointTiles = new Set();

  // How many travel landmarks each world ends up with, across BOTH authoring
  // routes -- the standalone `waypoints` array and an `is_waypoint: true` portal
  // link departing from that world (SOMET-300). Reported after both loops,
  // because a world's total is not known until the links have been walked.
  //
  // Backed by waypoints_world_unique in the database. Two enforcement points on
  // purpose: this one names the offending world at seed time, the index binds
  // every other writer.
  const waypointsPerWorld = new Map();
  function countWaypoint(worldKey, n = 1) {
    if (n > 0) waypointsPerWorld.set(worldKey, (waypointsPerWorld.get(worldKey) || 0) + n);
  }

  // Shared by the world loop (standalone waypoints) and the link loop
  // (portal-backed ones) so the two authoring routes cannot enforce different
  // rules -- which is exactly how one of them ends up being the loose one.
  function checkWaypoint({ worldKey, x, y, name, label, world }) {
    if (typeof name !== 'string' || name.trim() === '') {
      errors.push(`${label} name must be a non-empty string`);
    } else if (waypointNames.has(name)) {
      errors.push(`duplicate waypoint name "${name}" — waypoint names are unique across the whole map, `
        + 'because the travel list shows them side by side');
    } else {
      waypointNames.add(name);
    }

    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      errors.push(`${label} x and y must be integers (pixels)`);
      return;
    }
    if (x < 0 || y < 0) { errors.push(`${label} x and y must not be negative`); return; }
    // A waypoint outside the map is a tile no player can ever stand on, so it
    // is a row that can never be activated rather than a feature. Only checked
    // when the world's own dimensions validated -- otherwise the real error is
    // the missing width/height, already reported.
    if (world && Number.isInteger(world.width) && Number.isInteger(world.height)
        && (x >= world.width * SPEC_TILE_SIZE || y >= world.height * SPEC_TILE_SIZE)) {
      errors.push(`${label} at (${x},${y}) is outside world "${worldKey}" `
        + `(${world.width}x${world.height} tiles)`);
      return;
    }

    const slot = tileSlot(worldKey, x, y);
    if (guardedStaircaseTiles.has(slot)) {
      errors.push(`${label} sits on a guarded portal in world "${worldKey}" `
        + `(guarded by ${guardedStaircaseTiles.get(slot)}) — a waypoint there is a guard the player `
        + 'never has to meet, and the level band it defends stops holding');
    }
    if (waypointTiles.has(slot)) {
      errors.push(`world "${worldKey}" already has a waypoint on tile `
        + `(${Math.floor(y / SPEC_TILE_SIZE)},${Math.floor(x / SPEC_TILE_SIZE)}) — only one of them `
        + 'could ever be walked onto');
    }
    waypointTiles.add(slot);
  }

  for (const w of worlds) {
    if (byKey.has(w.key)) errors.push(`duplicate key "${w.key}"`);
    byKey.set(w.key, w);
    if (seenNames.has(w.name)) errors.push(`duplicate name "${w.name}"`);
    seenNames.add(w.name);

    // Before every other per-world check, and NOT behind a `continue`: a world
    // that also fails its grid check must still have its unknown keys named,
    // or the author fixes the grid and gets a second surprise.
    const unknown = Object.keys(w).filter((k) => !WORLD_KEYS.has(k));
    if (unknown.length) {
      errors.push(`world "${w.key}" has unknown key(s) ${unknown.join(', ')} -- `
        + 'nothing reads them, so they would be silently ignored. Remove them, or '
        + 'add them to WORLD_KEYS in seeds/mapSpec.js once a reader exists.');
    }

    const gridRequired = !portalConnectedKeys.has(w.key);
    if (!hasValidGrid(w)) {
      if (gridRequired) { errors.push(`world "${w.key}" grid must be two integers`); continue; }
      // else: portal-only world, grid legitimately absent -- fall through to width/height/etc checks
    } else {
      const cell = `${w.grid[0]},${w.grid[1]}`;
      if (cells.has(cell)) {
        errors.push(`worlds "${cells.get(cell)}" and "${w.key}" occupy the same grid cell ${cell}`);
      }
      cells.set(cell, w.key);
    }

    // Presence + integrality only -- NOT the admin API's 8-4096 range. That
    // range belongs to POST /api/worlds (src/index.js) and is enforced there;
    // duplicating it here would let this validator's numbers drift from the
    // API's. Without even this much, `width`/`height` are nullable columns
    // and seed-map.js passes w.width/w.height straight into the INSERT with
    // no `?? ` fallback (unlike chunk_size just below it in that file) -- an
    // omitted width/height silently writes NULL, producing
    // a world the World Map tab reports as "not linkable" with no validator
    // error to explain why.
    if (!Number.isInteger(w.width)) {
      errors.push(`world "${w.key}" width must be an integer`);
    }
    if (!Number.isInteger(w.height)) {
      errors.push(`world "${w.key}" height must be an integer`);
    }

    // Optional. Validated here as well as by worlds_level_band_check because
    // `make reseed-map` clears every world BEFORE seeding: a band rejected
    // only by the database would fail after the destruction, leaving the
    // developer with no maps at all.
    if (w.level_band !== undefined) {
      const b = w.level_band;
      if (!Array.isArray(b) || b.length !== 2
          || !Number.isInteger(b[0]) || !Number.isInteger(b[1])) {
        errors.push(`world "${w.key}" level_band must be [min, max] with integer values`);
      } else if (b[0] < 1) {
        errors.push(`world "${w.key}" level_band minimum must be at least 1`);
      } else if (b[1] < b[0]) {
        errors.push(`world "${w.key}" level_band maximum must be >= its minimum`);
      }
    }

    // Optional. Validated here as well as by worlds_density_check for the
    // same reason level_band is: `make reseed-map` clears every world BEFORE
    // seeding, so a tier rejected only by the database would fail after the
    // destruction, leaving the developer with no maps at all.
    if (w.density !== undefined && !DENSITY_NAMES.includes(w.density)) {
      errors.push(
        `world "${w.key}" density must be one of ${DENSITY_NAMES.join(', ')} (got "${w.density}")`);
    }

    // Optional, defaults to false at the column. Rejected rather than coerced:
    // "true" and 1 are the two ways a hand-edited spec gets this wrong, and
    // coercing either would flag a world as a fast-travel target on the
    // strength of a typo -- which is exactly how a portal-guarded dungeon
    // would quietly become reachable without passing its guard.
    if (w.allows_fast_travel !== undefined && typeof w.allows_fast_travel !== 'boolean') {
      errors.push(
        `world "${w.key}" allows_fast_travel must be true or false `
        + `(got ${JSON.stringify(w.allows_fast_travel)})`);
    }

    // Retired: creature_count is now derived from `density` by populateWorld
    // and written back to the column. Accepting both would give one number two
    // authored sources, and the spec's would silently lose on every populate.
    if (w.creature_count !== undefined) {
      errors.push(
        `world "${w.key}" creature_count is no longer authored -- use "density" instead`);
    }

    if (w.village && Array.isArray(w.villages)) {
      errors.push(`world "${w.key}" declares both "village" and "villages" — use one`);
    }
    // Reject rather than coerce, same posture as safe_road_radius below: a
    // typo'd `villages: {...}` (an easy mistake, since the sibling singular
    // `village` key IS an object) must not silently fall through to
    // villagesOf's `w.village` fallback and validate as "no villages here" --
    // that is a village silently missing, the SOMET-153 failure class.
    if (w.villages !== undefined && !Array.isArray(w.villages)) {
      errors.push(`world "${w.key}" villages must be an array (got ${typeof w.villages})`);
    }
    // Same posture for the singular key: `village: null`, `village: false`,
    // or a misspelled key must be REPORTED, not read by villagesOf's
    // `w.village ? [w.village] : []` as "no village here" -- that is a
    // village silently missing, the exact SOMET-153 failure class this
    // branch already hardened the plural form against.
    if (w.village !== undefined && (typeof w.village !== 'object' || w.village === null)) {
      errors.push(`world "${w.key}" village must be an object (got ${JSON.stringify(w.village)})`);
    }
    const villages = villagesOf(w);
    for (const v of villages) {
      // A null/non-object entry inside an otherwise well-formed array (e.g.
      // `villages: [null]`) must be REPORTED, not dereferenced -- `v.width`
      // on null throws and aborts validateMapSpec entirely, hiding every
      // other problem the rest of the spec has. Same posture as the
      // container-level checks above.
      if (!v || typeof v !== 'object') {
        errors.push(`world "${w.key}" villages entry must be an object (got ${JSON.stringify(v)})`);
        continue;
      }
      if (!(v.width >= VILLAGE_LIMITS.minW && v.width <= VILLAGE_LIMITS.maxW)) {
        errors.push(`world "${w.key}" village width must be between 3 and 8 tiles`);
      }
      if (!(v.height >= VILLAGE_LIMITS.minH && v.height <= VILLAGE_LIMITS.maxH)) {
        errors.push(`world "${w.key}" village height must be between 3 and 6 tiles`);
      }
      if (!['N', 'E', 'S', 'W'].includes(v.gate_edge)) {
        errors.push(`world "${w.key}" village gate_edge must be one of N,E,S,W`);
      }
      // The geometry rules the HTTP API enforces (validateVillageBody in
      // src/index.js), imported rather than restated: the SOMET-282 on-screen
      // size budget (width + height <= VILLAGE_LIMITS.maxSum, which the
      // per-axis checks above cannot express) and the SOMET-153 interior-spawn
      // rule. seed-map.js calls createVillage directly and so never passed
      // through that route: three seeded hubs shipped with a spawn on the
      // SOUTH wall ring, and respawn-at-village dropped the player inside the
      // wall. Same function object as index.js calls, so the two call sites
      // cannot drift. Applied to EVERY entry, not just the first -- a rule
      // that checks one element of a list is the same half-applied rule in a
      // new costume.
      const geomErr = villageGeometryError(v);
      if (geomErr) errors.push(`world "${w.key}" village ${geomErr}`);
    }
    // Overlapping boxes would stamp two wall rings through each other, leaving
    // a village with a hole in it and a gate that opens into another village's
    // wall. Cheap O(n^2) -- a world has single-digit villages.
    for (let i = 0; i < villages.length; i++) {
      for (let j = i + 1; j < villages.length; j++) {
        // Already reported above as a malformed entry; skip rather than
        // dereference a null/non-object village a second time here.
        if (!villages[i] || typeof villages[i] !== 'object'
          || !villages[j] || typeof villages[j] !== 'object') continue;
        if (boxesOverlap(villages[i], villages[j])) {
          errors.push(`world "${w.key}" villages overlap `
            + `(rows ${villages[i].min_row} and ${villages[j].min_row})`);
        }
      }
    }

    // SOMET-288 safe territory. Rejected rather than coerced, for the reason
    // allows_fast_travel states above: "3" and true are how a hand-edited spec
    // gets this wrong, and coercing either would widen or silently disable a
    // safe corridor on the strength of a typo.
    if (w.safe_road_radius !== undefined) {
      const r = w.safe_road_radius;
      if (!Number.isInteger(r) || r < 0 || r > MAX_SAFE_ROAD_RADIUS) {
        errors.push(`world "${w.key}" safe_road_radius must be an integer `
          + `between 0 and ${MAX_SAFE_ROAD_RADIUS} (got ${JSON.stringify(r)})`);
      }
    }
    // A non-array safe_rects (e.g. one accidental object instead of a list of
    // them) must be REPORTED, not thrown -- `for...of` on a non-iterable
    // aborts validateMapSpec entirely, hiding every other problem the rest of
    // the spec has. Same reject-rather-than-coerce posture as the checks
    // above it.
    if (w.safe_rects !== undefined && !Array.isArray(w.safe_rects)) {
      errors.push(`world "${w.key}" safe_rects must be an array (got ${typeof w.safe_rects})`);
    }
    for (const s of Array.isArray(w.safe_rects) ? w.safe_rects : []) {
      // A null/non-object entry (e.g. `safe_rects: [null]`) must be REPORTED,
      // not dereferenced -- `s.min_row` on null throws and aborts
      // validateMapSpec entirely, hiding every other problem the rest of the
      // spec has. Same posture as the container-level check above.
      if (!s || typeof s !== 'object') {
        errors.push(`world "${w.key}" safe_rects entry must be an object (got ${JSON.stringify(s)})`);
        continue;
      }
      const bad = !Number.isInteger(s.min_row) || !Number.isInteger(s.min_col)
        || !Number.isInteger(s.width) || !Number.isInteger(s.height)
        || s.width < 1 || s.height < 1
        || s.min_row < 0 || s.min_col < 0
        || s.min_row + s.height > w.height || s.min_col + s.width > w.width;
      if (bad) {
        errors.push(`world "${w.key}" safe_rects entry must be a positive box `
          + `inside the ${w.width}x${w.height} map (got ${JSON.stringify(s)})`);
      }
    }

    // SOMET-289 authored roads. Same reject-rather-than-coerce posture as
    // safe_rects above, and for a sharper version of the same reason: nothing
    // downstream would notice a malformed polyline until the generator's walker
    // either looped on a diagonal or drew nothing at all, and a road that
    // silently does not exist takes its safe corridor with it.
    //
    // The rules are re-stated here rather than delegated to mapService's
    // normalizeAuthoredRoads because that function THROWS (correct for a
    // generator that has no way to report), while validateMapSpec must collect
    // every problem in a spec and name them all at once. The in-bounds check
    // below is additionally something normalizeAuthoredRoads cannot make: it
    // has no map dimensions.
    if (w.roads !== undefined && !Array.isArray(w.roads)) {
      errors.push(`world "${w.key}" roads must be an array (got ${typeof w.roads})`);
    }
    for (const [i, line] of (Array.isArray(w.roads) ? w.roads : []).entries()) {
      if (!Array.isArray(line) || line.length === 0) {
        errors.push(`world "${w.key}" roads[${i}] must be a non-empty array of [row, col] points`);
        continue;
      }
      let prev = null;
      for (const [j, p] of line.entries()) {
        if (!Array.isArray(p) || p.length !== 2
            || !Number.isInteger(p[0]) || !Number.isInteger(p[1])) {
          errors.push(`world "${w.key}" roads[${i}][${j}] must be a [row, col] pair of `
            + `integers (got ${JSON.stringify(p)})`);
          prev = null;
          continue;
        }
        // Strictly inside the wall ring. A road cell ON the ring is overwritten
        // by stampBounds, so it would be an authored road tile that is never
        // drawn -- while still widening the safe corridor, which is the two
        // halves of this feature disagreeing.
        if (Number.isInteger(w.height) && Number.isInteger(w.width)
            && (p[0] < 1 || p[0] > w.height - 2 || p[1] < 1 || p[1] > w.width - 2)) {
          errors.push(`world "${w.key}" roads[${i}][${j}] point ${JSON.stringify(p)} must lie `
            + `strictly inside the ${w.width}x${w.height} map's wall ring`);
        }
        // Consecutive points share a row or a column. A diagonal has no defined
        // rasterisation, and guessing one would put the drawn road somewhere
        // the author did not choose.
        if (prev && prev[0] !== p[0] && prev[1] !== p[1]) {
          errors.push(`world "${w.key}" roads[${i}] segment ${j - 1}->${j} is not axis-aligned `
            + `(${JSON.stringify(prev)} -> ${JSON.stringify(p)})`);
        }
        prev = p;
      }
    }

    // SOMET-289 pens. Geometry comes from services/pens.js's penGeometryError,
    // imported rather than restated for the same cannot-drift-apart reason
    // villageGeometryError is: the placer and the validator must agree about
    // what fits, or a spec validates and then seeds a pen that under-delivers.
    if (w.pens !== undefined && !Array.isArray(w.pens)) {
      errors.push(`world "${w.key}" pens must be an array (got ${typeof w.pens})`);
    }
    const pens = Array.isArray(w.pens) ? w.pens : [];
    for (const p of pens) {
      if (!p || typeof p !== 'object') {
        errors.push(`world "${w.key}" pens entry must be an object (got ${JSON.stringify(p)})`);
        continue;
      }
      const penErr = penGeometryError(p, { width: w.width, height: w.height });
      if (penErr) errors.push(`world "${w.key}" pen ${penErr}`);
      if (creatureTypeNames && !creatureTypeNames.has(p.creature_type)) {
        errors.push(`world "${w.key}" pen references unknown creature type `
          + `"${p.creature_type}"`);
      }
    }
    // A pen overlapping a village would have its creatures placed around the
    // village rather than in the pen (the placer refuses village tiles), so the
    // pen silently under-delivers -- and any that did land inside would break
    // the epic's invariant that only Village Guards stand in a village.
    for (const p of pens) {
      if (!p || typeof p !== 'object' || !Number.isInteger(p.min_row)) continue;
      for (const v of villages) {
        if (!v || typeof v !== 'object') continue;
        if (boxesOverlap(p, v)) {
          errors.push(`world "${w.key}" pen at rows ${p.min_row}..${p.min_row + p.height - 1} `
            + `overlaps the village at rows ${v.min_row}..${v.min_row + v.height - 1}`);
        }
      }
    }

    if (w.waypoints !== undefined) {
      if (!Array.isArray(w.waypoints)) {
        errors.push(`world "${w.key}" waypoints must be an array`);
      } else {
        // AT MOST ONE PER WORLD (SOMET-300) -- counted in waypointsPerWorld and
        // reported after the link loop, NOT here.
        //
        // A world can acquire a waypoint by TWO routes: this standalone array,
        // and an `is_waypoint: true` portal link departing from it. Counting only
        // this one would let a spec declare a stone here and flag a staircase in
        // the same world, which is two landmarks on one map and exactly what the
        // ticket removes. The database index caught that gap while this comment's
        // first version was still counting one route.
        countWaypoint(w.key, w.waypoints.length);
        for (const [i, wp] of w.waypoints.entries()) {
          if (!wp || typeof wp !== 'object') {
            errors.push(`world "${w.key}" waypoint ${i} must be an object`);
            continue;
          }
          checkWaypoint({
            worldKey: w.key, x: wp.x, y: wp.y, name: wp.name, world: w,
            label: `world "${w.key}" waypoint ${i}`,
          });
        }
      }
    }

    if (biomeNames) {
      for (const b of w.biomes ?? []) {
        if (!biomeNames.has(b)) errors.push(`world "${w.key}" references unknown biome "${b}"`);
      }
    }
    if (creatureTypeNames) {
      for (const c of w.allowed_creature_types ?? []) {
        if (!creatureTypeNames.has(c)) {
          errors.push(`world "${w.key}" references unknown creature type "${c}"`);
        }
      }
    }
  }

  const entries = worlds.filter((w) => w.is_entry === true);
  if (entries.length !== 1) {
    errors.push(`spec must have exactly one world with is_entry: true (found ${entries.length})`);
  }

  // SOMET-335. If the entry world declares a village, entry_spawn must BE that
  // village's spawn tile.
  //
  // This is SOMET-153's original acceptance criterion, and migration
  // 1714440175000 (SOMET-282) delivered it on the LIVE rows by writing
  // worlds.entry_spawn FROM villages.spawn_x/spawn_y, precisely so the two
  // could not disagree. That guarantee is not durable: applyMapSpec upserts
  // entry_spawn from the spec on every re-seed, so a spec that disagrees
  // silently undoes the migration. Nothing anywhere related the two numbers
  // until this check, and hub-vale/hub shipped with entry_spawn on the map
  // CENTRE and its village 20 tiles away -- through an authoring pass, a
  // resize (SOMET-307, which translated both correctly and so preserved the
  // inconsistency exactly) and every re-seed since.
  //
  // Scoped to a village the entry world actually declares: an entry world with
  // no village is still legal (loop-catacombs/entry is one), and this must not
  // start demanding villages that were never part of that spec's design.
  // entry_spawn is REQUIRED once a village is declared, because "absent" is
  // the same failure as "wrong" -- the player still does not start in the
  // village.
  //
  // Compared as tile-exact pixel pairs rather than "inside the box": these two
  // are the same point (first join and respawn land on the same tile), not
  // merely compatible ones. villageGeometryError already proves separately
  // that the village's own spawn is a legal interior tile, so equality here
  // carries interiority with it.
  //
  // Only villages that are themselves WELL-FORMED are compared against. A
  // malformed entry (null, a string, a missing spawn) already has its own
  // error from the village block above, and this check has nothing meaningful
  // to say about it -- reading `.spawn_x` off it would THROW, aborting
  // validateMapSpec and hiding every other problem in the spec, which is the
  // posture every other check here deliberately avoids.
  if (entries.length === 1) {
    const entry = entries[0];
    const entryVillages = villagesOf(entry).filter(
      (v) => v && typeof v === 'object'
        && Number.isInteger(v.spawn_x) && Number.isInteger(v.spawn_y),
    );
    if (entryVillages.length > 0) {
      const spawn = entry.entry_spawn;
      const spawns = entryVillages.map((v) => `${v.spawn_x},${v.spawn_y}`);
      if (!spawn || !Number.isInteger(spawn.x) || !Number.isInteger(spawn.y)) {
        errors.push(`entry world "${entry.key}" declares a village but no integer entry_spawn `
          + '-- a new character\'s first join and their respawn point must be the village spawn tile');
      } else if (!spawns.includes(`${spawn.x},${spawn.y}`)) {
        errors.push(`entry world "${entry.key}" entry_spawn (${spawn.x},${spawn.y}) is not the spawn `
          + `of any village it declares (${spawns.join(' / ')}) -- a new character would start `
          + 'outside the starting village');
      }
    }
  }

  const usedEdges = new Set();
  // Every portal TILE a spec claims, whichever side of a link declared it.
  // setPortalLink writes TWO rows per declared link -- the declared
  // (from, from_x, from_y) and the implicit mirror at (to, to_x, to_y) -- and
  // both upsert on the same partial unique index (from_world_id, from_x,
  // from_y) WHERE edge = 'PORTAL'. So tracking only the declared side lets a
  // spec whose two links converge on ONE arrival tile validate clean, and the
  // second setPortalLink call then silently overwrites the first's mirror
  // row: one of the two portals ships one-way, with no error anywhere.
  //
  // Maps the tile to the DESTINATION the row landing on it will carry, not
  // just to "seen". A spec that redundantly declares both directions of the
  // same portal claims each tile twice with identical destinations -- those
  // writes are byte-identical and idempotent, so they destroy nothing and
  // must not be reported as a conflict.
  const usedPortalTiles = new Map();
  const adjacency = new Map(worlds.map((w) => [w.key, []]));
  for (const l of links) {
    const from = byKey.get(l.from);
    const to = byKey.get(l.to);
    if (!from) { errors.push(`link references unknown world "${l.from}"`); continue; }
    if (!to) { errors.push(`link references unknown world "${l.to}"`); continue; }

    if (l.kind === 'portal') {
      // Rejected rather than coerced, for exactly the reason allows_fast_travel
      // is: "true" and 1 are how a hand-edited spec gets a boolean wrong, and
      // coercing either would turn a staircase into a travel target on the
      // strength of a typo -- which is the guarded-entrance bypass arriving by
      // accident instead of on purpose.
      if (l.is_waypoint !== undefined && typeof l.is_waypoint !== 'boolean') {
        errors.push(`portal link ${l.from}->${l.to} is_waypoint must be true or false `
          + `(got ${JSON.stringify(l.is_waypoint)})`);
      }
      const coordFields = ['from_x', 'from_y', 'to_x', 'to_y'];
      const badField = coordFields.find((f) => !Number.isInteger(l[f]));
      if (badField) {
        errors.push(`portal link ${l.from}->${l.to} ${badField} must be an integer`);
        adjacency.get(l.from).push(l.to);
        adjacency.get(l.to).push(l.from);
        continue;
      }
      // Departure side first, then the mirror this link implies, so the
      // error names the tile that actually collides.
      const departure = `${l.from}:${l.from_x},${l.from_y}`;
      const arrival = `${l.to}:${l.to_x},${l.to_y}`;
      const claimed = [
        { slot: departure, leadsTo: arrival, world: l.from, x: l.from_x, y: l.from_y, side: 'departure' },
        { slot: arrival, leadsTo: departure, world: l.to, x: l.to_x, y: l.to_y, side: 'arrival' },
      ];
      for (const c of claimed) {
        const prior = usedPortalTiles.get(c.slot);
        if (prior !== undefined && prior !== c.leadsTo) {
          errors.push(`world "${c.world}" already has a portal on tile (${c.x},${c.y}) leading to `
            + `${prior} — portal link ${l.from}->${l.to} claims that tile again as its ${c.side} `
            + `tile, and the second write would overwrite the first, leaving one of them one-way`);
        }
        usedPortalTiles.set(c.slot, c.leadsTo);
      }

      if (l.guard) {
        if (!Number.isInteger(l.guard.count) || l.guard.count < 1) {
          errors.push(`portal link ${l.from}->${l.to} guard count must be a positive integer`);
        }
        if (creatureTypeNames && !creatureTypeNames.has(l.guard.creature_type)) {
          errors.push(`portal link ${l.from}->${l.to} references unknown creature type "${l.guard.creature_type}"`);
        }
      }

      // A flagged staircase is a waypoint on its OWN departure tile: that is
      // the tile a player walks onto, and it is where the registry row lands.
      // checkWaypoint carries the guarded-staircase rejection, so a link that
      // guards itself is caught here without this branch restating the rule.
      if (l.is_waypoint === true) {
        // The SECOND authoring route into waypointsPerWorld (SOMET-300).
        countWaypoint(l.from);
        checkWaypoint({
          worldKey: l.from, x: l.from_x, y: l.from_y, name: l.waypoint_name, world: from,
          label: `portal link ${l.from}->${l.to} waypoint`,
        });
      }

      adjacency.get(l.from).push(l.to);
      adjacency.get(l.to).push(l.from);
      continue;
    }

    // A compass doorway is a three-tile gap in a wall ring stamped by
    // stampBounds, not an authored point -- there is no single tile to record
    // as a waypoint, and a doorway you can walk through is not a shortcut worth
    // recording anyway. Flagged here rather than ignored, so an author who
    // tries it is told the flag did nothing instead of finding out later.
    if (l.is_waypoint !== undefined) {
      errors.push(`link ${l.from}->${l.to} is a compass doorway and cannot be a waypoint — `
        + 'is_waypoint belongs on a portal link, which has a tile');
    }

    if (!EDGE_DELTA[l.edge]) { errors.push(`link ${l.from}->${l.to} has invalid edge "${l.edge}"`); continue; }

    const slot = `${l.from}:${l.edge}`;
    if (usedEdges.has(slot)) {
      errors.push(`world "${l.from}" already has a link on edge ${l.edge} — UNIQUE(from_world_id, edge) allows one`);
    }
    usedEdges.add(slot);

    // A world with a malformed grid already produced a "grid must be two
    // integers" error in the world loop above; here we must not dereference
    // grid[0]/grid[1] on it (that throws instead of returning errors). Skip
    // the geometry check but still record adjacency, so an otherwise-valid
    // link doesn't also spuriously fail reachability.
    if (!hasValidGrid(from) || !hasValidGrid(to)) {
      adjacency.get(l.from).push(l.to);
      adjacency.get(l.to).push(l.from);
      continue;
    }

    const [dx, dy] = EDGE_DELTA[l.edge];
    const wantX = from.grid[0] + dx;
    const wantY = from.grid[1] + dy;
    if (to.grid[0] !== wantX || to.grid[1] !== wantY) {
      const adjacent = Math.abs(to.grid[0] - from.grid[0]) + Math.abs(to.grid[1] - from.grid[1]) === 1;
      errors.push(adjacent
        ? `link ${l.from}->${l.to} declares edge ${l.edge} but the grid puts "${l.to}" elsewhere`
        : `link ${l.from}->${l.to} declares edge ${l.edge} but the cells are not adjacent`);
    }

    adjacency.get(l.from).push(l.to);
    adjacency.get(l.to).push(l.from);   // links are bidirectional (setLink mirrors)
  }

  if (entries.length === 1) {
    const seen = new Set([entries[0].key]);
    const queue = [entries[0].key];
    while (queue.length) {
      for (const next of adjacency.get(queue.shift()) ?? []) {
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    for (const w of worlds) {
      if (!seen.has(w.key)) errors.push(`world "${w.key}" is unreachable from the entry`);
    }
  }

  // The one-per-world ceiling, after both routes have been counted. Sorted so
  // the message order is a property of the spec rather than of Map insertion.
  for (const [worldKey, n] of [...waypointsPerWorld.entries()].sort()) {
    if (n > 1) {
      errors.push(`world "${worldKey}" declares ${n} waypoints — a world may hold at most `
        + 'one, since a portal is the single travel landmark of its map. Count includes '
        + 'both a standalone `waypoints` entry and any portal link flagged is_waypoint '
        + 'departing from this world.');
    }
  }

  return errors;
}

module.exports = { validateMapSpec, EDGE_DELTA, villagesOf };
