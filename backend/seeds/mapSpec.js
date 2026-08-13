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

// True only when w.grid is a well-formed [int, int] pair. Shared by the
// world loop (which reports the error) and the link loop (which must not
// dereference grid[0]/grid[1] on a world that failed this check -- a link
// naming a world with a missing/null/malformed grid must produce an error,
// not throw).
function hasValidGrid(w) {
  return Array.isArray(w.grid) && w.grid.length === 2
      && Number.isInteger(w.grid[0]) && Number.isInteger(w.grid[1]);
}

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
function tileSlot(worldKey, x, y) {
  return `${worldKey}:${Math.floor(x / SPEC_TILE_SIZE)},${Math.floor(y / SPEC_TILE_SIZE)}`;
}

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
        + `(${Math.floor(x / SPEC_TILE_SIZE)},${Math.floor(y / SPEC_TILE_SIZE)}) — only one of them `
        + 'could ever be walked onto');
    }
    waypointTiles.add(slot);
  }

  for (const w of worlds) {
    if (byKey.has(w.key)) errors.push(`duplicate key "${w.key}"`);
    byKey.set(w.key, w);
    if (seenNames.has(w.name)) errors.push(`duplicate name "${w.name}"`);
    seenNames.add(w.name);

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

    if (w.village) {
      const v = w.village;
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
      // cannot drift.
      const geomErr = villageGeometryError(v);
      if (geomErr) errors.push(`world "${w.key}" village ${geomErr}`);
    }

    if (w.waypoints !== undefined) {
      if (!Array.isArray(w.waypoints)) {
        errors.push(`world "${w.key}" waypoints must be an array`);
      } else {
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

  return errors;
}

module.exports = { validateMapSpec, EDGE_DELTA };
