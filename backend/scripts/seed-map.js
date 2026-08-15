#!/usr/bin/env node
// Apply a map spec. Run via `make seed-map SPEC=<name>`.
//
// Idempotent by worlds.name (worlds_name_unique, migration 1714440037000):
// re-applying an unchanged spec is a no-op. The whole apply is one transaction
// -- a spec that fails halfway must not leave a half-built map that the World
// Map tab then renders as a broken graph.
//
// RESTART THE BACKEND AFTER SEEDING AGAINST A RUNNING STACK.
// A biome change reshapes terrain, and the backend caches terrain in FOUR
// places. PUT /api/worlds/:id busts all four (src/index.js: DELETE
// world_chunks, worldPreviewCache.delete, clearOverviewCache, evictOrWarn).
// This is a separate process, so it can only reach the one that lives in
// Postgres -- the world_chunks DELETE below. The world-preview cache, the
// minimap overview cache and the authority's in-memory copy of a live world
// all sit in the backend's heap and keep serving the OLD terrain until it
// restarts: the preview and minimap draw a world that no longer exists, and a
// player already inside one collides against terrain the database no longer
// has. Nothing a CLI can fix -- restart the backend. The notice printed at the
// end of a run says so.
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const { validateMapSpec, villagesOf } = require('../seeds/mapSpec.js');
const { fetchLinks, setLink, setPortalLink } = require('../src/services/mapLinks.js');
const {
  createVillage, fetchVillages, repositionVillage, rederiveVillageGuards,
} = require('../src/services/villages.js');
const {
  pensOf, placePenCreatures, insertPenCreatures, worldHasPennedCreatures,
} = require('../src/services/pens.js');
const { insertPortalGuards } = require('../src/services/dungeonGuards.js');
const { insertVaultChest } = require('../src/services/chests.js');
const {
  upsertWaypoint, pruneWaypoints, foreignWaypointNames, guardedWaypointViolations,
} = require('../src/services/waypoints.js');
const { populateWorld } = require('../src/services/worldPopulation.js');
const { assertNavigable } = require('../src/services/navigability.js');
const { buildWorldGenConfig } = require('../src/services/worldGenConfig.js');
const { loadTileTypes } = require('../src/services/tileTypes.js');
const { loadBiomes } = require('../src/services/biomes.js');
const { setEntryWorld } = require('../src/services/entryWorld.js');

// Pixels per grid cell for the World Map tab's canvas coordinates. Deriving
// graph_x/graph_y from the same grid the links were validated against is what
// guarantees the drawn diagram agrees with the links.
//
// Sign convention: grid[0] is +x = East, grid[1] is +y = South (screen-down),
// exactly EDGE_DELTA in seeds/mapSpec.js (E:[1,0], W:[-1,0], S:[0,1], N:[0,-1])
// and STEP in frontend/src/games/something2/mapGraphLayout.js:10. Multiplying
// grid straight through (no negation) is what keeps this agreement -- flipping
// the sign of either axis here would draw the World Map tab mirrored against
// the links a spec actually declares. 220 also matches that file's own
// `cell = 220` fallback spacing for worlds with no stored graph position.
const GRID_SPACING = 220;

// Pure so it's unit-testable without a database: see tests/seed_map.test.js.
function graphPosition(grid) {
  return { x: grid[0] * GRID_SPACING, y: grid[1] * GRID_SPACING };
}

// The tiles a world must keep connected: where a player starts, and every way
// in or out. Tile coordinates, not pixels -- CREATURE_TILE_PX is 100.
//
// `doorwayEdges` is the edge list already fetched from map_links for THIS
// world (fetchLinks(client, worldId), non-portal rows) -- not spec.links
// filtered on `l.from === w.key`. Compass links are bidirectional: setLink
// writes a mirror row, and stampBounds stamps a doorway gap for every edge
// fetchLinks returns, in both directions. A world that is only a link
// TARGET in the spec (e.g. `{ from: 'a', edge: 'E', to: 'b' }` for world
// "b") has no row in spec.links with `from === 'b'`, so filtering on that
// would silently produce zero doorway requirements for it -- exactly the
// case where a doorway is stamped into the wall ring but never checked for
// reachability. Portals stay sourced from spec.links: a portal is declared
// once with both endpoints, so it doesn't have this problem.
function requiredTilesFor(w, spec, row, doorwayEdges) {
  const out = [];
  if (row.entry_spawn && Number.isFinite(row.entry_spawn.x)) {
    out.push({
      row: Math.floor(row.entry_spawn.y / 100),
      col: Math.floor(row.entry_spawn.x / 100),
      what: 'entry spawn',
    });
  }
  // DOORWAY_TILES is 3 and the gap is centred, spanning midCol-1..midCol+1,
  // so the centre column is always inside it.
  const midCol = Math.floor(row.width / 2);
  const midRow = Math.floor(row.height / 2);
  const edges = new Set(doorwayEdges);
  // TWO tiles per doorway, and the second is the one that can actually fail.
  //
  // The gap itself is stamped `map_doorway` by stampBounds, so it is walkable
  // BY CONSTRUCTION and asserts nothing on its own -- for a world with one
  // doorway and no entry_spawn it used to be the ONLY required tile, which made
  // assertNavigable flood-fill from it with nothing to compare against and
  // return clean unconditionally. That is how Blackfen Sinks shipped sealed.
  //
  // The tile that matters is the ARRIVAL point one tile inward: exactly what
  // mapService.arrivalPoint returns for an inbound player, and generated
  // terrain, so it can be water / cave_wall / chasm. Keep the gap FIRST anyway
  // -- assertNavigable fills from the first entry, and only the gap is a safe
  // anchor. Distinct labels so a failure names the real problem.
  for (const e of edges) {
    if (e === 'N') {
      out.push({ row: 0, col: midCol, what: 'doorway N' });
      out.push({ row: 1, col: midCol, what: 'arrival via doorway N' });
    }
    if (e === 'S') {
      out.push({ row: row.height - 1, col: midCol, what: 'doorway S' });
      out.push({ row: row.height - 2, col: midCol, what: 'arrival via doorway S' });
    }
    if (e === 'W') {
      out.push({ row: midRow, col: 0, what: 'doorway W' });
      out.push({ row: midRow, col: 1, what: 'arrival via doorway W' });
    }
    if (e === 'E') {
      out.push({ row: midRow, col: row.width - 1, what: 'doorway E' });
      out.push({ row: midRow, col: row.width - 2, what: 'arrival via doorway E' });
    }
  }
  for (const l of (spec.links || [])) {
    if (l.kind !== 'portal') continue;
    if (l.from === w.key) {
      out.push({ row: Math.floor(l.from_y / 100), col: Math.floor(l.from_x / 100), what: `portal source to ${l.to}` });
    }
    if (l.to === w.key) {
      out.push({ row: Math.floor(l.to_y / 100), col: Math.floor(l.to_x / 100), what: `portal arrival from ${l.from}` });
    }
  }
  // A doorway GAP is walkable by construction (stampBounds stamps map_doorway
  // on the ring), so it always anchors the fill safely. Ordering matters:
  // assertNavigable starts from the FIRST entry. `arrival via doorway N` and
  // friends deliberately do NOT match this prefix -- an arrival tile is
  // generated terrain and may be water, which would make it the worst possible
  // anchor (assertNavigable would early-return and blame every other tile).
  out.sort((a, b) => (a.what.startsWith('doorway') ? -1 : 0) - (b.what.startsWith('doorway') ? -1 : 0));
  return out;
}

async function applyMapSpec(pool, spec) {
  const catalogs = {
    biomeNames: new Set((await pool.query('SELECT name FROM biomes')).rows.map((r) => r.name)),
    creatureTypeNames: new Set(
      (await pool.query('SELECT name FROM entity_types WHERE is_creature = true')).rows.map((r) => r.name)),
  };
  const errors = validateMapSpec(spec, catalogs);
  if (errors.length) {
    throw new Error(`invalid spec "${spec.name}":\n  - ${errors.join('\n  - ')}`);
  }

  const client = await pool.connect();
  const idByKey = new Map();
  try {
    await client.query('BEGIN');

    // Counted per loop iteration actually completed, not read back from
    // spec.worlds.length/spec.links.length -- a return value that only ever
    // echoes the input's own length would still read as "correct" even if a
    // future edit silently skipped an element inside either loop (e.g. a
    // stray `continue`/`slice`), because the length of the input array never
    // changes. Counting real iterations makes the return value witness what
    // was actually written, the same way `villages` below already does.
    let worldsWritten = 0;
    let linksWritten = 0;
    let portalGuardsWritten = 0;
    let creaturesWritten = 0;
    let vaultChestsWritten = 0;

    for (const w of spec.worlds) {
      // A grid-less (portal-only) world has nothing to derive a World Map
      // position from -- graph_x/graph_y stay NULL, exactly the same NULL
      // the frontend already treats as "no stored position, use the layout
      // fallback" for any world an admin hasn't dragged yet.
      const pos = w.grid ? graphPosition(w.grid) : { x: null, y: null };
      const r = await client.query(
        `INSERT INTO worlds (name, seed, chunk_size, width, height,
                             allowed_creature_types, entry_spawn, biomes, biome_cell,
                             graph_x, graph_y, level_min, level_max, density,
                             allows_fast_travel, safe_road_radius, safe_rects,
                             authored_roads, pens)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,
                 $18::jsonb,$19::jsonb)
         ON CONFLICT (name) DO UPDATE
           SET seed = EXCLUDED.seed, chunk_size = EXCLUDED.chunk_size,
               width = EXCLUDED.width, height = EXCLUDED.height,
               allowed_creature_types = EXCLUDED.allowed_creature_types,
               entry_spawn = EXCLUDED.entry_spawn, biomes = EXCLUDED.biomes,
               biome_cell = EXCLUDED.biome_cell,
               graph_x = EXCLUDED.graph_x, graph_y = EXCLUDED.graph_y,
               level_min = EXCLUDED.level_min, level_max = EXCLUDED.level_max,
               density = EXCLUDED.density,
               -- Re-asserted on every seed, like every other authored column.
               -- The spec is the source of truth, so removing the key from a
               -- spec must take the flag back OFF rather than leave a world
               -- permanently travellable because it once was.
               allows_fast_travel = EXCLUDED.allows_fast_travel,
               -- Re-asserted on every seed, like allows_fast_travel above and
               -- for the same reason: the spec is the source of truth, so
               -- deleting the key from a spec must take the safety back OFF
               -- rather than leave a world permanently safe because it once was.
               safe_road_radius = EXCLUDED.safe_road_radius,
               safe_rects = EXCLUDED.safe_rects,
               -- Re-asserted on every seed for the same reason as the two
               -- above. Note the asymmetry this creates and which the village
               -- warning below already documents: an authored ROAD converges to
               -- the spec on every seed, but the pen CREATURES a pen once
               -- placed do not (they are inserted once, like village guards).
               -- Editing a pen's box in a spec therefore moves the authored
               -- rectangle without moving the creatures already standing in it.
               authored_roads = EXCLUDED.authored_roads,
               pens = EXCLUDED.pens
         RETURNING id`,
        [w.name, w.seed, w.chunk_size ?? 64, w.width, w.height,
         JSON.stringify(w.allowed_creature_types ?? []),
         w.entry_spawn ? JSON.stringify(w.entry_spawn) : null,
         JSON.stringify(w.biomes ?? []), w.biome_cell ?? null,
         pos.x, pos.y,
         w.level_band ? w.level_band[0] : 1,
         w.level_band ? w.level_band[1] : 1,
         w.density ?? 'normal',
         w.allows_fast_travel === true,
         w.safe_road_radius ?? 0,
         JSON.stringify(w.safe_rects ?? []),
         JSON.stringify(w.roads ?? []),
         JSON.stringify(w.pens ?? [])],
      );
      idByKey.set(w.key, r.rows[0].id);
      worldsWritten += 1;

      // Terrain is derived from `biomes`/`seed`/`biome_cell`, and world_chunks
      // caches generated terrain. Re-pointing a world at a new biome without
      // clearing this makes it serve stale chunks forever.
      //
      // Safe to delete unconditionally only since P1 (SOMET-246): that INSERT
      // used to double as activateChunk's once-only creature-spawn flag, and
      // P1 deleted the block it gated. The table is now purely a deterministic
      // cache -- a deleted row costs a regeneration, nothing more.
      await client.query('DELETE FROM world_chunks WHERE world_id = $1', [r.rows[0].id]);
    }

    // After every world exists, so a link can never reference a missing
    // target. setLink/setPortalLink write the mirror row themselves -- never
    // INSERT into map_links here. portalLinkIds records the FORWARD row's id
    // per source tile, for the guard-insertion pass below.
    const portalLinkIds = new Map(); // `${fromKey}:${from_x},${from_y}` -> link id
    for (const l of spec.links) {
      if (l.kind === 'portal') {
        const { id } = await setPortalLink(
          client, idByKey.get(l.from), l.from_x, l.from_y, idByKey.get(l.to), l.to_x, l.to_y);
        portalLinkIds.set(`${l.from}:${l.from_x},${l.from_y}`, id);
      } else {
        await setLink(client, idByKey.get(l.from), l.edge, idByKey.get(l.to));
      }
      linksWritten += 1;
    }

    // Guard packs are a separate pass (after every portal link exists) and
    // are call-site-guarded the same way village guards are just below:
    // insertPortalGuards is a bare INSERT with no ON CONFLICT, so re-applying
    // an unchanged spec would double the pack on every run without this check.
    for (const l of spec.links) {
      if (l.kind !== 'portal' || !l.guard) continue;
      const linkId = portalLinkIds.get(`${l.from}:${l.from_x},${l.from_y}`);
      const existingGuards = await client.query(
        'SELECT 1 FROM world_creatures WHERE blocks_portal_id = $1 LIMIT 1', [linkId]);
      if (existingGuards.rowCount === 0) {
        await insertPortalGuards(
          client, idByKey.get(l.from), linkId, l.from_x, l.from_y, l.guard.creature_type, l.guard.count);
        portalGuardsWritten += l.guard.count;
      }
    }

    // Waypoints (SOMET-292). After the guard pass, so every guarded staircase
    // this spec declares already exists in the database to be checked against,
    // and long before populateWorld, which does not read them.
    //
    // BOTH the flag and the rows converge to the spec. The is_waypoint FLAG is
    // re-asserted false on every portal link the spec does not flag, exactly as
    // allows_fast_travel is re-asserted on every world. The waypoint ROWS are
    // pruned to the set of names the spec authors -- see pruneWaypoints for why
    // that is worth cascading a character's activations, and why not converging
    // them (the first shape of this pass) was a security hole rather than a
    // tidiness gap: the runtime reads the registry, so a row nobody authors any
    // more is still a live travel target.
    //
    // Prune BEFORE upserting, not after: it is what frees a tile (or a
    // staircase) that a renamed waypoint used to hold, so the upserts below run
    // against a registry that already contains only this spec's waypoints.
    const authoredWaypoints = [];
    for (const l of spec.links) {
      if (l.kind !== 'portal') continue;
      const linkId = portalLinkIds.get(`${l.from}:${l.from_x},${l.from_y}`);
      await client.query('UPDATE map_links SET is_waypoint = $2 WHERE id = $1',
        [linkId, l.is_waypoint === true]);
      if (l.is_waypoint !== true) continue;
      authoredWaypoints.push({
        worldId: idByKey.get(l.from), x: l.from_x, y: l.from_y,
        name: l.waypoint_name, mapLinkId: linkId,
      });
    }
    for (const w of spec.worlds) {
      for (const wp of w.waypoints ?? []) {
        authoredWaypoints.push({
          worldId: idByKey.get(w.key), x: wp.x, y: wp.y, name: wp.name, mapLinkId: null,
        });
      }
    }

    const touchedWorldIds = [...idByKey.values()];
    const authoredNames = authoredWaypoints.map((wp) => wp.name);
    const waypointsRemoved = await pruneWaypoints(client, touchedWorldIds, authoredNames);
    const foreign = await foreignWaypointNames(client, touchedWorldIds, authoredNames);
    if (foreign.length) {
      throw new Error(
        'waypoint names are unique across every map:\n  - '
        + foreign.map((f) => `"${f.name}" already exists in world "${f.world_name}", which this spec `
          + 'does not own -- seeding would move it').join('\n  - '));
    }
    let waypointsWritten = 0;
    for (const wp of authoredWaypoints) {
      await upsertWaypoint(client, wp);
      waypointsWritten += 1;
    }

    // The rule this slice exists to enforce, asked of the DATABASE rather than
    // of the spec text (SOMET-292 review, finding 1). validateMapSpec already
    // refuses `guard` and `is_waypoint` on one link, but it only ever sees the
    // spec: a spec that drops `guard:` while adding the flag validates clean and
    // still lands a waypoint on a staircase whose guard creatures are alive in
    // world_creatures (worldPopulation deliberately spares them). This is the
    // last write to either table in the transaction -- populateWorld only
    // deletes creatures with blocks_portal_id IS NULL, and nothing after it
    // touches waypoints -- so a clean answer here is a clean answer at COMMIT.
    const violations = await guardedWaypointViolations(client, touchedWorldIds);
    if (violations.length) {
      throw new Error(
        'refusing to seed: a waypoint would let a player skip a guarded portal:\n  - '
        + violations.map((v) => `waypoint "${v.waypoint}" in world "${v.world}" -- ${v.how}, and that `
          + `staircase is guarded by ${v.guards}. The guards are live rows; a spec that stops `
          + 'declaring `guard` does not remove them').join('\n  - '));
    }

    // Villages CONVERGE to the spec (SOMET-312), the same way every authored
    // column on `worlds` already does.
    //
    // This pass used to be all-or-nothing per world -- a world that held any
    // village was skipped whole, and only a COUNT difference warned. A village
    // whose box had moved is 1 row against 1 declaration, so it drifted in
    // total silence; SOMET-308 hit it in a browser, spawning the player at a
    // resized world's centre with the village still 16 tiles away. The reason
    // given for the skip was that "a village has no identity beyond its box".
    // It has one now: `key`, required by validateMapSpec and stored in
    // villages.spec_key, which is what lets this MOVE a village instead of
    // guessing whether it is the same one.
    //
    // What still does NOT happen here is a DELETE. A village row owns its
    // merchant_stock by ON DELETE CASCADE, and that stock includes items
    // players listed for sale, so dropping a village the spec stopped
    // declaring would confiscate player property on the strength of an edit to
    // a JSON file. Those rows are reported instead, loudly, and left for a
    // human -- `make reseed-map` (which clears every world first) is still the
    // way to converge a removal.
    let villages = 0;
    let villagesMoved = 0;
    for (const w of spec.worlds) {
      const specVillages = villagesOf(w);
      if (specVillages.length === 0) continue;
      const worldId = idByKey.get(w.key);
      const existing = (await client.query(
        // created_at ASC is the order fetchVillages uses and the order this
        // loop created them in on the first seed, so "the Nth row" and "the Nth
        // spec entry" mean the same thing for anything this script wrote. `id`
        // breaks the tie for two villages created inside one transaction, where
        // now() -- and so created_at -- is identical for both.
        `SELECT id, spec_key, min_row, min_col, width, height, gate_edge, spawn_x, spawn_y
           FROM villages WHERE world_id = $1 ORDER BY created_at ASC, id ASC`,
        [worldId],
      )).rows;

      // --- match spec entries to live rows -------------------------------
      // Three passes, most certain first. Nothing is ever matched by guesswork:
      // a leftover on either side is reported rather than paired up.
      const claimed = new Set();
      const matched = new Map();   // spec village -> live row (or undefined)

      // 1. By key. The only match that survives a move, and the only one that
      //    exists at all once a database has been seeded by this version.
      const byKey = new Map(existing.filter((r) => r.spec_key != null).map((r) => [r.spec_key, r]));
      for (const v of specVillages) {
        const row = byKey.get(v.key);
        if (row) { matched.set(v, row); claimed.add(row.id); }
      }

      // 2. ADOPTION, exact box. A row written before spec_key existed carries
      //    no key, but if its box is still byte-for-byte what the spec says
      //    then which village it is cannot be in doubt. Stamping the key here
      //    is what makes the NEXT edit to that box a move rather than a
      //    re-adoption -- and it is why no migration backfills this column
      //    (SOMET-335: a migration that repairs seeded content is undone by the
      //    next re-seed; the seed path has to be the one that converges).
      const sameBox = (r, v) => r.min_row === v.min_row && r.min_col === v.min_col
        && r.width === v.width && r.height === v.height
        && String(r.gate_edge).trim() === v.gate_edge;
      for (const v of specVillages) {
        if (matched.has(v)) continue;
        const row = existing.find((r) => r.spec_key == null && !claimed.has(r.id) && sameBox(r, v));
        if (row) { matched.set(v, row); claimed.add(row.id); }
      }

      // 3. ADOPTION, last one standing. The MOVE case on a database seeded
      //    before this key existed: the box no longer matches anything, so
      //    step 2 cannot see it. Allowed only when exactly one unmatched spec
      //    entry faces exactly one unclaimed unkeyed row -- with one candidate
      //    on each side there is nothing to choose between, so this is
      //    deduction and not a guess. Two of either and the pass stops and
      //    reports; pairing them off in array order would be inventing an
      //    identity, which is the mistake this whole ticket is about.
      // Recomputed from `claimed` rather than captured, so step 3's own claim
      // is visible to the apply loop below.
      const unclaimedRows = () => existing.filter((r) => !claimed.has(r.id));
      const orphanSpec = specVillages.filter((v) => !matched.has(v));
      const orphanRows = unclaimedRows();
      if (orphanSpec.length === 1 && orphanRows.length === 1 && orphanRows[0].spec_key == null) {
        matched.set(orphanSpec[0], orphanRows[0]);
        claimed.add(orphanRows[0].id);
      }

      // --- apply -----------------------------------------------------------
      let guardsStale = false;
      for (const v of specVillages) {
        const row = matched.get(v);
        if (!row) {
          // Create ONLY when no unmatched live row is left, because any such
          // row could be this very village under a box nobody recognises --
          // creating alongside it would leave the world holding both. This is
          // what makes "add a second village to a seeded world" (SOMET-289)
          // work while "the spec and the rows have diverged in a way nothing
          // can untangle" still refuses to act.
          if (unclaimedRows().length > 0) continue;   // ambiguous; reported below
          await createVillage(client, worldId, v);
          villages += 1;
          continue;
        }
        // TWO different reasons to write, kept apart on purpose.
        //
        // `placementChanged` is the real event: the box, the gate or the spawn
        // no longer match the spec. `row.spec_key !== v.key` on its own is only
        // the adoption stamp -- the first run after SOMET-312 finds every live
        // village unkeyed and has to write the key, and that is not a move.
        // Folding the two together would print "MOVED from rows 44..47 to rows
        // 44..47" for every village in the game on that one run, and would
        // re-derive every guard in the game with it. A warning that cries wolf
        // once per village is a warning nobody reads the next time.
        //
        // Compared against the SPEC field by field, and merchant_x/merchant_y
        // are deliberately NOT in it: they are derived from the box, so
        // comparing them would compare villageMerchantPost against itself and
        // always agree.
        const placementChanged = !sameBox(row, v)
          || Number(row.spawn_x) !== v.spawn_x || Number(row.spawn_y) !== v.spawn_y;
        if (!placementChanged && row.spec_key === v.key) continue;

        const { before, after } = await repositionVillage(client, row.id, v);
        if (!placementChanged) {
          console.log(
            `seed-map: world "${w.key}" (${w.name}) adopted its existing village as `
            + `"${v.key}" (unchanged box). A later spec edit can now move it.`);
          continue;
        }
        guardsStale = true;
        villagesMoved += 1;

        // A player_binds row IS a village's spawn point -- authority/server.js
        // writes `{ x: v.spawnX, y: v.spawnY }` when a player enters a village,
        // and death returns them to it. Leaving it behind would respawn every
        // bound player on the patch of ground the village used to occupy, which
        // is now open terrain (or water, or the inside of a wall the generator
        // put there). Matched on the OLD spawn in THIS world, so it moves
        // exactly the binds this village issued and nothing else.
        const rebound = await client.query(
          `UPDATE player_binds SET x = $2, y = $3, updated_at = now()
            WHERE world_id = $1 AND x = $4 AND y = $5`,
          [worldId, after.spawn_x, after.spawn_y, before.spawn_x, before.spawn_y],
        );

        console.warn(
          `seed-map: world "${w.key}" (${w.name}) village "${v.key}" MOVED from `
          + `rows ${before.min_row}..${before.min_row + before.height - 1}, `
          + `cols ${before.min_col}..${before.min_col + before.width - 1} `
          + `(spawn ${before.spawn_x},${before.spawn_y}) to `
          + `rows ${after.min_row}..${after.min_row + after.height - 1}, `
          + `cols ${after.min_col}..${after.min_col + after.width - 1} `
          + `(spawn ${after.spawn_x},${after.spawn_y}). Its merchant stock and `
          + `id are kept; ${rebound.rowCount} player bind(s) followed it.`);
      }

      // Guards live in world_creatures with no village_id, so nothing moves
      // them for us: a moved village would keep two level-150 guards standing
      // in open ground at its old gate, and its new gate would be undefended.
      // Re-derived once per world (the wipe is world-scoped) and ONLY when
      // something moved -- doing it on every seed would heal every guard in the
      // game on every run. createVillage inserts its own, so a world where
      // nothing moved but something was created is already correct.
      if (guardsStale) await rederiveVillageGuards(client, worldId);

      // What is left over. Loud, because this is the only feedback loop there
      // is, and it is the same argument the old count warning made: every other
      // authored column converges, so an author reasonably assumes villages do
      // too and otherwise finds out in a browser.
      const stillOrphanSpec = specVillages.filter((v) => !matched.has(v));
      const stillOrphanRows = unclaimedRows();
      if (stillOrphanSpec.length && stillOrphanRows.length) {
        console.warn(
          `seed-map: world "${w.key}" (${w.name}) has ${stillOrphanRows.length} village row(s) `
          + `that match no key in its spec (${stillOrphanRows.map((r) => r.spec_key == null
            ? `unkeyed at rows ${r.min_row}..${r.min_row + r.height - 1}` : `"${r.spec_key}"`).join(', ')}) `
          + `and ${stillOrphanSpec.length} spec village(s) with no live row `
          + `(${stillOrphanSpec.map((v) => `"${v.key}"`).join(', ')}). Which is which cannot be `
          + 'deduced, so NOTHING was applied for them. Give the live rows their spec keys, or run '
          + 'make reseed-map to re-seed this map from scratch.');
      } else if (stillOrphanRows.length) {
        console.warn(
          `seed-map: world "${w.key}" (${w.name}) has ${stillOrphanRows.length} village row(s) `
          + 'the spec no longer declares '
          + `(${stillOrphanRows.map((r) => r.spec_key == null
            ? `unkeyed at rows ${r.min_row}..${r.min_row + r.height - 1}` : `"${r.spec_key}"`).join(', ')}). `
          + 'They were LEFT IN PLACE: deleting a village cascades its merchant_stock, including '
          + 'items players listed for sale. Delete them by hand, or run make reseed-map.');
      }
    }

    // Vault chests: same idempotency shape as villages just above (one
    // authored chest per seeded world, guarded by insertVaultChest the same
    // way createVillage guards a village). Runs after villages and before
    // populateWorld -- so a chest and a village guard both exist before
    // populateWorld samples tile candidates, and so a future teach-in of
    // creatureTileCandidates to avoid chest tiles (not done by this task,
    // see Task 3's "explicitly out of scope") has a chest row to check
    // against once it lands.
    for (const w of spec.worlds) {
      if (!w.chest) continue;
      const worldId = idByKey.get(w.key);
      const existing = await client.query('SELECT id FROM world_chests WHERE world_id = $1', [worldId]);
      if (existing.rowCount === 0) {   // idempotent: one authored chest per seeded world
        await insertVaultChest(client, worldId, {
          x: w.chest.x, y: w.chest.y,
          guardCreatureType: w.chest.guard_creature_type,
          level: w.chest.level,
        });
        vaultChestsWritten += 1;
      }
    }

    // Pens (SOMET-289). AFTER villages, because the pen placer refuses village
    // tiles and needs the village rows to know where they are, and BEFORE
    // populateWorld -- deliberately, even though the ordering is not forced.
    //
    // populateWorld opens with a DELETE that spares only `type = 'Village
    // Guard'`, a non-null blocks_portal_id, or a non-null home_x. Every penned
    // creature carries home_x, so running the pen pass first makes the very
    // next statement in the same transaction PROVE that sparing works, instead
    // of leaving it to be discovered on the second seed. That is the exact
    // shape of the vault-chest pass above, and it is how SOMET-244 and
    // SOMET-246 were both caught.
    let penCreatures = 0;
    for (const w of spec.worlds) {
      const specPens = w.pens ?? [];
      if (specPens.length === 0) continue;
      const worldId = idByKey.get(w.key);
      const wr = await client.query('SELECT * FROM worlds WHERE id = $1', [worldId]);
      const row = wr.rows[0];
      const pens = pensOf(row);

      // Idempotent per world, the same all-or-nothing shape villages use.
      //
      // Asked THROUGH pens.js, because "a homed, non-guard, non-portal row" is
      // NOT unique to a pen: insertVaultChest and spawnFieldChest anchor their
      // guard the same way, and the vault-chest pass a few lines above runs
      // FIRST. A world declaring both a chest and pens would otherwise seed the
      // chest, see its guard here, and skip its pen pass on the very first seed
      // and every one after -- silently, which is the whole failure class
      // services/pens.js was written to close. So the anchor is tested against
      // this world's authored pen boxes as well; see pennedCreatureFilter.
      if (await worldHasPennedCreatures(client, worldId, pens)) continue;

      const worldLinks = await fetchLinks(client, worldId);
      const world = buildWorldGenConfig({
        row,
        tileTypes: await loadTileTypes(client),
        doorways: worldLinks.filter((l) => l.edge !== 'PORTAL').map((l) => l.edge),
        villages: await fetchVillages(client, worldId),
        biomes: await loadBiomes(client, row.biomes),
      });

      for (const [i, pen] of pens.entries()) {
        const et = await client.query(
          'SELECT name, hp, defense FROM entity_types WHERE name = $1 AND is_creature = true',
          [pen.creatureType],
        );
        // The validator already rejects an unknown creature_type against the
        // live catalog, so this is a belt-and-braces guard for a spec applied
        // to a database whose catalog was seeded differently. Loud, because a
        // pen that holds nothing is the failure this feature is built around.
        if (et.rowCount === 0) {
          throw new Error(
            `world "${w.key}" pen ${i} references creature type "${pen.creatureType}", `
            + 'which is not a creature in this database\'s entity_types');
        }
        // Salted off the world seed and the pen index so two pens in one world
        // do not lay out identically, and a re-seed reproduces both.
        const placed = placePenCreatures(world, pen, et.rows[0], (w.seed ^ (0x9e37 + i)) >>> 0);
        if (placed.length < pen.count) {
          console.warn(
            `seed-map: world "${w.key}" pen ${i} (${pen.creatureType}) placed `
            + `${placed.length} of ${pen.count} -- the box has fewer placeable tiles than `
            + 'the count asks for (walls, water or a village inside it).');
        }
        await insertPenCreatures(client, worldId, placed);
        penCreatures += placed.length;
      }
    }

    // MUST be after links (populateWorld reads them for doorway tiles), after
    // portal guards (its delete spares guards, but a guard must already exist
    // to be spared) and -- the non-obvious one -- after VILLAGES.
    //
    // populateWorld fetches this world's villages and creatureTileCandidates
    // refuses any tile inside one. On a FIRST seed, running before the village
    // loop means fetchVillages returns [] and that exclusion silently does
    // nothing: hostiles get scattered across the village footprint and
    // createVillage then stamps its walls around them. It also makes seeding
    // non-idempotent -- the first apply samples against no village, every
    // later apply samples against one, so the same unchanged spec lays its
    // creatures out differently (SOMET-246 final review, finding 1; covered by
    // seed_map_db.test.js's "seeding a spec with a village is idempotent and
    // keeps hostiles out of the village"). `make reseed-map` runs clear-maps
    // first, so every seed it performs is a first seed.
    //
    // Village guards are unaffected by the move: populateWorld's delete spares
    // `type = 'Village Guard'`, so the guards createVillage just inserted
    // survive the pass that runs moments later.
    //
    // Seeded worlds CONVERGE to their spec: populateWorld deletes non-guard
    // creatures and re-places them, so editing a density tier and re-seeding
    // takes effect. The alternative -- populate only when empty -- makes a
    // spec edit silently do nothing, a worse trap than the killed creatures
    // coming back that this costs.
    for (const w of spec.worlds) {
      const worldId = idByKey.get(w.key);
      const wr = await client.query('SELECT * FROM worlds WHERE id = $1', [worldId]);
      const n = await populateWorld(client, wr.rows[0], { rngSeed: w.seed });
      creaturesWritten += n.total;
    }

    // Ten biomes band impassable terrain (cave_wall / rubble / chasm). A blob
    // over a spawn, or a doorway walled off from the interior, produces a
    // dungeon nobody can enter -- and walking into it is the only other way to
    // find out. Generation is deterministic, so checking here is exact.
    const tileTypes = await loadTileTypes(client);
    for (const w of spec.worlds) {
      const worldId = idByKey.get(w.key);
      const wr = await client.query('SELECT * FROM worlds WHERE id = $1', [worldId]);
      const row = wr.rows[0];
      const worldLinks = await fetchLinks(client, worldId);
      const doorways = worldLinks.filter((l) => l.edge !== 'PORTAL').map((l) => l.edge);
      const biomes = await loadBiomes(client, row.biomes);
      const villages = await fetchVillages(client, worldId);
      const cfg = buildWorldGenConfig({ row, tileTypes, doorways, villages, biomes });

      const required = requiredTilesFor(w, spec, row, doorways);
      const problems = assertNavigable(cfg, required);
      if (problems.length) {
        throw new Error(
          `world "${w.key}" is not navigable:\n  - ${problems.join('\n  - ')}`);
      }
    }

    // LAST: setting is_entry clears it on every other world (index.js:1542),
    // so doing this mid-apply would fight itself as later worlds are written.
    const entry = spec.worlds.find((w) => w.is_entry);
    if (entry) {
      // One atomic statement via the shared writer (services/entryWorld.js).
      // This site was already safe -- it runs inside the apply transaction, so
      // its old clear-then-set pair could not be observed half-done -- but it
      // is the third copy of an idiom whose other two copies were both wrong,
      // and a third copy is how the next one goes wrong too.
      await setEntryWorld(client, idByKey.get(entry.key));
    }

    await client.query('COMMIT');
    return {
      worlds: worldsWritten, links: linksWritten, villages,
      // Counted separately from `villages` (created): a run that reports 0
      // created and 3 moved has done real work, and the old return shape had
      // no way to say so -- which is precisely how a drifted village stayed
      // invisible behind "0 villages" on every re-seed (SOMET-312).
      villagesMoved,
      portalGuards: portalGuardsWritten, creatures: creaturesWritten,
      vaultChests: vaultChestsWritten, waypoints: waypointsWritten,
      // Reported, not just done: a prune cascades character_waypoints, so a
      // re-seed that quietly un-lights a waypoint for every player must say so.
      waypointsRemoved: waypointsRemoved.length,
      penCreatures,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { applyMapSpec, GRID_SPACING, graphPosition, requiredTilesFor };

if (require.main === module) {
  const name = process.env.SPEC;
  if (!name) { console.error('SPEC is required, e.g. make seed-map SPEC=hub-vale'); process.exit(1); }
  const file = path.resolve(__dirname, '../seeds/maps', `${name}.map.json`);
  if (!fs.existsSync(file)) { console.error(`no such spec: ${file}`); process.exit(1); }
  const env = dotenv.config({ path: path.resolve(__dirname, '../../.env') }).parsed || {};
  const url = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set in .env'); process.exit(1); }
  const pool = new Pool({ connectionString: url });
  applyMapSpec(pool, JSON.parse(fs.readFileSync(file, 'utf8')))
    .then((n) => {
      console.log(
        `applied ${name}: ${n.worlds} worlds, ${n.links} links, `
        + `${n.villages} villages (${n.villagesMoved} moved), `
        + `${n.portalGuards} portal guards, ${n.creatures} creatures, ${n.vaultChests} vault chests, `
        + `${n.waypoints} waypoints (${n.waypointsRemoved} removed), `
        + `${n.penCreatures} pen creatures`);
      // See this file's header: only the world_chunks cache is reachable from
      // here. Printed unconditionally rather than probed -- this process has no
      // way to tell whether a backend is up, and a note that only appears
      // sometimes is a note nobody learns to read.
      console.log(
        'NOTE: if the backend is running, RESTART IT. This process cannot clear its '
        + 'world-preview cache, its minimap overview cache, or its in-memory copy of a '
        + 'live world, so those keep serving the old terrain.');
    })
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
