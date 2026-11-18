// SOMET-773: give a world its ruins, or keep the ones it has.
//
// ensureStructures loads everything the generator must respect from the
// database -- the world row, its links, villages, biomes, tile types, the
// decoration catalog, and every persisted thing standing on the map -- and
// writes the result to worlds.structures. Idempotent: a world whose stored
// ruins are still valid is left byte-identical and its chunk cache untouched.
//
// Stored `auto` ruins are re-validated every run, because seed-map can change
// a world's seed/size/biomes under them: a ruin whose footprint is no longer
// in bounds and walkable is dropped, and if the kept set no longer passes the
// navigability check they are all re-rolled. Anything else (`source: 'spec'`,
// SOMET-775) is the author's and is kept as written.
const { buildWorldGenConfig } = require('./worldGenConfig');
const { assertNavigable } = require('./navigability');
const { generateStructureSites, validSites, siteRequired } = require('./structureSites');
const { reconcileRuinChests } = require('./ruinChests');
const { loadTileTypes } = require('./tileTypes');
const { loadBiomes } = require('./biomes');
const { fetchVillages } = require('./villages');
const { fetchLinks } = require('./mapLinks');
const { loadDecorationDefs } = require('./decorationDefs');
const { arrivalPoints } = require('../../scripts/scan-decoration-seals.js');
const { STRUCTURE_TYPES, MONUMENT_TYPES } = require('../../seeds/data/structureTypes.js');

const T = 100;
const tile = (x, y) => ({ row: Math.floor(Number(y) / T), col: Math.floor(Number(x) / T) });

function eligible(row) {
  if (!row || !row.width || !row.height) return false;
  const name = String(row.name || '');
  return !/^Boss Arena:/.test(name) && !/: Hub$/.test(name);
}

async function pointsOf(db, sql, worldId) {
  const { rows } = await db.query(sql, [worldId]);
  return rows.filter((r) => Number.isFinite(Number(r.x)) && Number.isFinite(Number(r.y))).map((r) => tile(r.x, r.y));
}

// What the generator must keep reachable (required) and stand clear of (avoid).
async function constraintsFor(db, row, links, villages) {
  const doorways = links.filter((l) => l.edge !== 'PORTAL').map((l) => l.edge);
  // Both ends that land in THIS world: portals leaving it and portals arriving
  // from elsewhere (fetchLinks only returns the outgoing rows, without ids).
  const { rows: portals } = await db.query(
    `SELECT from_world_id, to_world_id, from_x, from_y, to_x, to_y FROM map_links
      WHERE edge = 'PORTAL' AND (from_world_id = $1 OR to_world_id = $1)`, [row.id]);
  const required = arrivalPoints(row, doorways, portals, villages);
  // A ruin's own chest and pack (SOMET-774) belong to the ruin: counting them
  // as things a ruin must keep clear of would invalidate the ruin that holds
  // them and re-roll it on every run.
  for (const p of await pointsOf(db, 'SELECT x, y FROM world_chests WHERE world_id = $1 AND structure_key IS NULL', row.id)) required.push({ ...p, what: 'chest' });
  for (const p of await pointsOf(db, 'SELECT x, y FROM waypoints WHERE world_id = $1', row.id)) required.push({ ...p, what: 'waypoint' });
  const avoid = [];
  for (const p of await pointsOf(db,
    `SELECT x, y FROM world_creatures wc WHERE world_id = $1 AND NOT EXISTS (
       SELECT 1 FROM world_chests ch WHERE ch.world_id = $1 AND ch.structure_key IS NOT NULL
          AND ch.guard_creature_ids @> to_jsonb(wc.id::text))`, row.id)) avoid.push({ ...p, radius: 0 });
  for (const p of await pointsOf(db, 'SELECT x, y FROM world_items WHERE world_id = $1', row.id)) avoid.push({ ...p, radius: 0 });
  for (const p of await pointsOf(db, 'SELECT x, y FROM creature_respawns WHERE world_id = $1', row.id)) avoid.push({ ...p, radius: 0 });
  for (const p of await pointsOf(db, 'SELECT x, y FROM world_players WHERE world_id = $1', row.id)) avoid.push({ ...p, radius: 2 });
  for (const p of await pointsOf(db, 'SELECT x, y FROM player_binds WHERE world_id = $1', row.id)) avoid.push({ ...p, radius: 2 });
  return { required, avoid, doorways };
}

// SOMET-776 art gate (spec: "no colour diamonds ship"): a NEW monument is
// placed only when its sprite has an approved image. Stored monuments are
// judged against the whole catalog, so approving or removing art never moves
// one that already stands.
async function monumentsWithArt(db, monuments) {
  if (!monuments.length) return [];
  const { rows } = await db.query(
    `SELECT name FROM entity_types WHERE name = ANY($1::text[]) AND COALESCE(image, '') <> ''`,
    [monuments.map((m) => m.sprite)]);
  const ok = new Set(rows.map((r) => r.name));
  return monuments.filter((m) => ok.has(m.sprite));
}

// `authored` (SOMET-775): the spec's resolved structures, passed by seed-map.
// They REPLACE every stored non-auto row (the spec is the source of truth, so
// an entry deleted from the spec goes). Omitted, stored spec rows are kept as
// written. `worlds.structures_auto = false` means no auto sites at all.
async function ensureStructures(db, worldId, { decorationDefs = null, regenerate = false, styles = STRUCTURE_TYPES, monuments = MONUMENT_TYPES, authored: authoredIn = null } = {}) {
  const { rows: [row] } = await db.query('SELECT * FROM worlds WHERE id = $1', [worldId]);
  if (!row) throw new Error(`ensureStructures: no world ${worldId}`);
  const stored = Array.isArray(row.structures) ? row.structures : [];
  const authored = authoredIn ? [...authoredIn] : stored.filter((s) => s.source !== 'auto');
  const autoOn = row.structures_auto !== false && eligible(row);
  // An ineligible world (boss arena, hub) or one with auto sites off keeps
  // only what its spec authored -- no generation, no seal re-roll to do.
  if (!autoOn) {
    const changed = JSON.stringify(authored) !== JSON.stringify(stored);
    if (changed) {
      await db.query('UPDATE worlds SET structures = $1::jsonb WHERE id = $2', [JSON.stringify(authored), worldId]);
      await db.query('DELETE FROM world_chunks WHERE world_id = $1', [worldId]);
    }
    const chests = authored.length || changed ? await reconcileRuinChests(db, worldId, { monuments }) : { added: 0, removed: 0 };
    return {
      world: row.name, skipped: !eligible(row), changed, chestsAdded: chests.added, chestsRemoved: chests.removed,
      kept: authored.length, added: 0, dropped: stored.filter((s) => s.source === 'auto').length,
    };
  }

  const [tileTypes, links, villages, biomes, defs] = await Promise.all([
    loadTileTypes(db), fetchLinks(db, worldId), fetchVillages(db, worldId), loadBiomes(db, row.biomes),
    decorationDefs ? Promise.resolve(decorationDefs) : loadDecorationDefs(db),
  ]);
  const { required, avoid, doorways } = await constraintsFor(db, row, links, villages);
  const world = buildWorldGenConfig({ row, tileTypes, doorways, villages, biomes, links });

  const auto = regenerate ? [] : stored.filter((s) => s.source === 'auto');
  // Same rules that placed them (structureSites.siteFits): a road, village,
  // portal or biome change since then invalidates a ruin it now conflicts with.
  // Judged against FIXED things only (terrain, biome, roads, villages,
  // required points) -- never `avoid`: creatures wander, items drop, players
  // log out somewhere new. A kept ruin invalidated by a transient position
  // would move on every re-seed (seed_map_db's idempotency test caught it:
  // the previous apply's hostiles re-rolled the ruins). NEW sites still avoid
  // every one of those positions.
  let keep = [...authored, ...validSites(world, auto, { styles, monuments, required, fixed: authored })];
  // A kept set that no longer passes the check (terrain moved around it) is
  // re-rolled whole rather than patched: partial survivors cannot be trusted.
  if (keep.length && assertNavigable({ ...world, structures: keep, noGeneratedRoads: true },
    [...required, ...siteRequired(keep.filter((s) => s.source !== 'spec'))], { decorationDefs: defs }).length) {
    keep = [...authored];
  }
  const placeable = await monumentsWithArt(db, monuments);
  const next = generateStructureSites(world, { styles, monuments: placeable, decorationDefs: defs, required, avoid, keep });
  const changed = JSON.stringify(next) !== JSON.stringify(stored);
  if (changed) {
    await db.query('UPDATE worlds SET structures = $1::jsonb WHERE id = $2', [JSON.stringify(next), worldId]);
    // Cached chunks hold the old ground. The authority's in-memory copy does
    // too -- a running backend must be restarted (or the world evicted).
    await db.query('DELETE FROM world_chunks WHERE world_id = $1', [worldId]);
  }
  // SOMET-774: the world's ruin chests follow its ruins (added for new POI
  // ruins, removed with ruins that went). Idempotent like everything above.
  const chests = await reconcileRuinChests(db, worldId, { world: { ...world, structures: next }, monuments });
  const keptAuto = keep.filter((s) => s.source === 'auto').length;
  return {
    world: row.name, skipped: false, changed, chestsAdded: chests.added, chestsRemoved: chests.removed,
    kept: keep.length, added: next.length - keep.length, dropped: regenerate ? 0 : auto.length - keptAuto,
  };
}

module.exports = { ensureStructures, eligible };
