#!/usr/bin/env node
// Apply a map spec. Run via `make seed-map SPEC=<name>`.
//
// Idempotent by worlds.name (worlds_name_unique, migration 1714440037000):
// re-applying an unchanged spec is a no-op. The whole apply is one transaction
// -- a spec that fails halfway must not leave a half-built map that the World
// Map tab then renders as a broken graph.
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const { validateMapSpec } = require('../seeds/mapSpec.js');
const { setLink, setPortalLink } = require('../src/services/mapLinks.js');
const { createVillage } = require('../src/services/villages.js');
const { insertPortalGuards } = require('../src/services/dungeonGuards.js');

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

    for (const w of spec.worlds) {
      // A grid-less (portal-only) world has nothing to derive a World Map
      // position from -- graph_x/graph_y stay NULL, exactly the same NULL
      // the frontend already treats as "no stored position, use the layout
      // fallback" for any world an admin hasn't dragged yet.
      const pos = w.grid ? graphPosition(w.grid) : { x: null, y: null };
      const r = await client.query(
        `INSERT INTO worlds (name, seed, chunk_size, width, height, creature_count,
                             allowed_creature_types, entry_spawn, biomes, biome_cell,
                             graph_x, graph_y, level_min, level_max)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14)
         ON CONFLICT (name) DO UPDATE
           SET seed = EXCLUDED.seed, chunk_size = EXCLUDED.chunk_size,
               width = EXCLUDED.width, height = EXCLUDED.height,
               creature_count = EXCLUDED.creature_count,
               allowed_creature_types = EXCLUDED.allowed_creature_types,
               entry_spawn = EXCLUDED.entry_spawn, biomes = EXCLUDED.biomes,
               biome_cell = EXCLUDED.biome_cell,
               graph_x = EXCLUDED.graph_x, graph_y = EXCLUDED.graph_y,
               level_min = EXCLUDED.level_min, level_max = EXCLUDED.level_max
         RETURNING id`,
        [w.name, w.seed, w.chunk_size ?? 64, w.width, w.height, w.creature_count ?? 0,
         JSON.stringify(w.allowed_creature_types ?? []),
         w.entry_spawn ? JSON.stringify(w.entry_spawn) : null,
         JSON.stringify(w.biomes ?? []), w.biome_cell ?? null,
         pos.x, pos.y,
         w.level_band ? w.level_band[0] : 1,
         w.level_band ? w.level_band[1] : 1],
      );
      idByKey.set(w.key, r.rows[0].id);
      worldsWritten += 1;
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

    // LAST: setting is_entry clears it on every other world (index.js:1542),
    // so doing this mid-apply would fight itself as later worlds are written.
    const entry = spec.worlds.find((w) => w.is_entry);
    if (entry) {
      await client.query('UPDATE worlds SET is_entry = false WHERE is_entry = true AND id <> $1',
        [idByKey.get(entry.key)]);
      await client.query('UPDATE worlds SET is_entry = true WHERE id = $1', [idByKey.get(entry.key)]);
    }

    await client.query('COMMIT');
    return { worlds: worldsWritten, links: linksWritten, villages, portalGuards: portalGuardsWritten };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { applyMapSpec, GRID_SPACING, graphPosition };

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
    .then((n) => console.log(
      `applied ${name}: ${n.worlds} worlds, ${n.links} links, ${n.villages} villages, ${n.portalGuards} portal guards`))
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
