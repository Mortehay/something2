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
const { validateMapSpec } = require('../seeds/mapSpec.js');
const { fetchLinks, setLink, setPortalLink } = require('../src/services/mapLinks.js');
const { createVillage, fetchVillages } = require('../src/services/villages.js');
const { insertPortalGuards } = require('../src/services/dungeonGuards.js');
const { populateWorld } = require('../src/services/worldPopulation.js');
const { assertNavigable } = require('../src/services/navigability.js');
const { buildWorldGenConfig } = require('../src/services/worldGenConfig.js');
const { loadTileTypes } = require('../src/services/tileTypes.js');
const { loadBiomes } = require('../src/services/biomes.js');

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
                             allows_fast_travel)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14,$15)
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
               allows_fast_travel = EXCLUDED.allows_fast_travel
         RETURNING id`,
        [w.name, w.seed, w.chunk_size ?? 64, w.width, w.height,
         JSON.stringify(w.allowed_creature_types ?? []),
         w.entry_spawn ? JSON.stringify(w.entry_spawn) : null,
         JSON.stringify(w.biomes ?? []), w.biome_cell ?? null,
         pos.x, pos.y,
         w.level_band ? w.level_band[0] : 1,
         w.level_band ? w.level_band[1] : 1,
         w.density ?? 'normal',
         w.allows_fast_travel === true],
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

    let villages = 0;
    for (const w of spec.worlds) {
      if (!w.village) continue;
      const worldId = idByKey.get(w.key);
      const existing = await client.query('SELECT id FROM villages WHERE world_id = $1', [worldId]);
      if (existing.rowCount === 0) {          // idempotent: one village per seeded world
        await createVillage(client, worldId, w.village);
        villages += 1;
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
      await client.query('UPDATE worlds SET is_entry = false WHERE is_entry = true AND id <> $1',
        [idByKey.get(entry.key)]);
      await client.query('UPDATE worlds SET is_entry = true WHERE id = $1', [idByKey.get(entry.key)]);
    }

    await client.query('COMMIT');
    return {
      worlds: worldsWritten, links: linksWritten, villages,
      portalGuards: portalGuardsWritten, creatures: creaturesWritten,
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
        `applied ${name}: ${n.worlds} worlds, ${n.links} links, ${n.villages} villages, `
        + `${n.portalGuards} portal guards, ${n.creatures} creatures`);
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
