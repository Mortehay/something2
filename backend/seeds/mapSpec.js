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
const { VILLAGE_LIMITS } = require('../src/services/villages.js');

// True only when w.grid is a well-formed [int, int] pair. Shared by the
// world loop (which reports the error) and the link loop (which must not
// dereference grid[0]/grid[1] on a world that failed this check -- a link
// naming a world with a missing/null/malformed grid must produce an error,
// not throw).
function hasValidGrid(w) {
  return Array.isArray(w.grid) && w.grid.length === 2
      && Number.isInteger(w.grid[0]) && Number.isInteger(w.grid[1]);
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
  for (const l of links) {
    if (l.kind === 'portal') { portalConnectedKeys.add(l.from); portalConnectedKeys.add(l.to); }
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
    // no `?? ` fallback (unlike chunk_size/creature_count just below it in
    // that file) -- an omitted width/height silently writes NULL, producing
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

      adjacency.get(l.from).push(l.to);
      adjacency.get(l.to).push(l.from);
      continue;
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
