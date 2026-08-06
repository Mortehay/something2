// The ONE place a world's hostile creature population is written.
//
// Before this module, placement had TWO implementations and only one was
// reachable. seed-map.js never populated at all -- it wrote creature_count
// onto the row and stopped -- so a seeded world stayed empty until someone
// clicked re-roll in the admin UI, one world at a time. The per-chunk path
// that looked like a fallback was gated on !isBoundedWorld, false for every
// world that has ever existed -- and has since been deleted as unreachable
// dead code (SOMET-246).
//
// Both callers -- applyMapSpec and POST /api/worlds/:id/creatures -- go
// through here and nowhere else, so seeding and re-rolling can never again
// produce different worlds from the same spec.
//
// BOUNDARY: hostile creatures only. Village guards (insertVillageGuards) and
// portal guards (insertPortalGuards) keep their own owners; the delete below
// is scoped to spare them, so a guard survives a repopulate.
const { placeMapCreatures, placeCreaturePacks, isBoundedWorld } = require('./mapService');
const { buildWorldGenConfig } = require('./worldGenConfig');
const { resolveDensity } = require('./densityTiers');
const { loadTileTypes } = require('./tileTypes');
const { loadBiomes } = require('./biomes');
const { fetchVillages } = require('./villages');
const { fetchLinks } = require('./mapLinks');

const GUARD_TYPE = 'Village Guard';

// Pack sizes are drawn from the tier's [min, max] band using the SAME seed the
// placement uses, so a repopulate at a fixed seed reproduces the same pack
// shapes as well as the same positions.
function packSpecsFor({ packCount, packSizeMin, packSizeMax }, rngSeed) {
  const specs = [];
  let s = (rngSeed ^ 0x5b17) >>> 0;
  for (let i = 0; i < packCount; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const span = packSizeMax - packSizeMin + 1;
    specs.push({ size: packSizeMin + (s % span) });
  }
  return specs;
}

async function populateWorld(client, worldRow, { rngSeed }) {
  if (!isBoundedWorld(worldRow)) {
    throw new Error(`world "${worldRow.name}" has no width/height and cannot be populated`);
  }

  // Every read is on the CALLER's client, never a fresh pool.query: this runs
  // inside the caller's transaction and must see its snapshot, and the
  // delete + inserts below must commit or fail with it (F-007 / SOMET-187 --
  // a failure between them otherwise leaves a world with zero creatures and
  // no endpoint that re-derives them).
  //
  // Sparing by `type <> GUARD_TYPE` alone only protects village guards.
  // Portal guards (dungeonGuards.js) reuse an ordinary hostile entity_types
  // row -- e.g. a spec can declare `guard: { creature_type: 'Wolf', ... }`
  // (seed_map_portals.test.js) -- so a 'Wolf' portal guard has neither
  // type = 'Village Guard' nor faction = 'guard', and a type-only filter
  // deletes it on the very next repopulate. blocks_portal_id IS NOT NULL is
  // the actual structural marker (migration 1714440061000): only a guard
  // defending a specific portal ever sets it, exactly like home_x/home_y is
  // only meaningful for guard-faction creatures. Found wiring this module
  // into applyMapSpec (SOMET-246 Task 6): seed_map_portals.test.js already
  // covered this and started failing once population ran in the same
  // transaction as portal guards for the first time.
  await client.query(
    'DELETE FROM world_creatures WHERE world_id = $1 AND type <> $2 AND blocks_portal_id IS NULL',
    [worldRow.id, GUARD_TYPE],
  );

  const allowedNames = Array.isArray(worldRow.allowed_creature_types)
    ? worldRow.allowed_creature_types : [];
  const density = resolveDensity(worldRow.density, worldRow.width, worldRow.height);

  // creature_count is written from what actually lands in world_creatures,
  // not the tier's target -- placeMapCreatures can under-deliver when
  // rejection sampling exhausts maxAttempts on a hostile map, and a world
  // with no allowed types or no matching hostile entity_types rows must show
  // 0, not a stale count from a previous populate. Every early return below
  // writes creature_count itself for that reason, rather than sharing one
  // write at the end.
  if (allowedNames.length === 0) {
    await client.query('UPDATE worlds SET creature_count = 0 WHERE id = $1', [worldRow.id]);
    return { scattered: 0, packed: 0, total: 0 };
  }

  const et = await client.query(
    `SELECT name, hp, defense, resistances, faction FROM entity_types
      WHERE is_creature = true AND name = ANY($1::text[])`,
    [allowedNames],
  );
  // Guards are structural, never wild spawns -- the same filter the re-roll
  // route already applied before this module existed.
  const hostileTypes = et.rows.filter((t) => (t.faction || 'hostile') !== 'guard');
  if (hostileTypes.length === 0) {
    await client.query('UPDATE worlds SET creature_count = 0 WHERE id = $1', [worldRow.id]);
    return { scattered: 0, packed: 0, total: 0 };
  }

  const tileTypes = await loadTileTypes(client);
  const villages = await fetchVillages(client, worldRow.id);
  const doorways = (await fetchLinks(client, worldRow.id))
    .filter((l) => l.edge !== 'PORTAL').map((l) => l.edge);
  const biomes = await loadBiomes(client, worldRow.biomes);
  const cfg = buildWorldGenConfig({ row: worldRow, tileTypes, doorways, villages, biomes });

  const scatter = placeMapCreatures(cfg, density.scatterCount, hostileTypes, rngSeed);
  const packed = placeCreaturePacks(
    cfg, packSpecsFor(density, rngSeed), hostileTypes, rngSeed);

  // Persisted from scatter.length (what was actually placed), not
  // density.scatterCount (what was asked for), so worlds.creature_count keeps
  // meaning "how many scattered creatures this world holds" for the admin UI
  // and every existing reader even when placement ships short.
  await client.query('UPDATE worlds SET creature_count = $1 WHERE id = $2',
    [scatter.length, worldRow.id]);

  for (const c of [...scatter, ...packed]) {
    await client.query(
      `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, level, damage, defense)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [worldRow.id, c.type, c.x, c.y, c.hp, c.facing, c.level, c.damage, c.defense],
    );
  }

  return { scattered: scatter.length, packed: packed.length, total: scatter.length + packed.length };
}

module.exports = { populateWorld, packSpecsFor, GUARD_TYPE };
