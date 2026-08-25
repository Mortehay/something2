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
const { placeMapCreatures, placeCreaturePacks, isBoundedWorld, makeRng } = require('./mapService');
const { buildWorldGenConfig } = require('./worldGenConfig');
const { resolveDensity } = require('./densityTiers');
const { loadTileTypes } = require('./tileTypes');
const { loadBiomes } = require('./biomes');
const { fetchVillages } = require('./villages');
const { fetchLinks } = require('./mapLinks');

const GUARD_TYPE = 'Village Guard';

// A third stream off the world's one seed, for the pack SIZES -- salted away
// from both scatter (makeRng(rngSeed)) and pack placement
// (makeRng(rngSeed ^ PACK_SALT)) so sizes are not correlated with where the
// packs land. A repopulate at a fixed seed reproduces the same pack shapes as
// well as the same positions.
const PACK_SPEC_SALT = 0x5b17;

// Uses makeRng, the mulberry32 every other seeded draw in this codebase goes
// through, rather than an inline LCG. The original wrote
// `s = (s * 1664525 + 1013904223) >>> 0` and took `s % span`: bit k of a
// mod-2^32 LCG has period at most 2^(k+1), so the low bits it was sampling
// barely move. Measured over 5000 seeds before the fix, `horde` (4 packs,
// sizes 5-8, span 4) produced a permutation of exactly {5,6,7,8} -- total 26 --
// for every seed that will ever exist, because 4 successive values of the low
// 2 bits cycle through all 4 residues; and `normal` (1 pack, span 2) picked 3
// or 4 purely by the parity of one draw. mulberry32 mixes before it returns,
// so Math.floor(rng() * span) is uniform over the whole span.
function packSpecsFor({ packCount, packSizeMin, packSizeMax }, rngSeed) {
  const specs = [];
  const rng = makeRng(((rngSeed >>> 0) ^ PACK_SPEC_SALT) >>> 0);
  const span = Math.max(1, packSizeMax - packSizeMin + 1);
  for (let i = 0; i < packCount; i++) {
    specs.push({ size: packSizeMin + Math.floor(rng() * span) });
  }
  return specs;
}

// How many creature rows go into one multi-row INSERT.
//
// One INSERT per creature was a network round-trip per creature inside an open
// write transaction -- at the top of the density range that is thousands of
// sequential awaits holding a pool connection and a row-lock footprint the
// whole time. Batched instead. 200 rows x 9 columns is 1800 bind parameters,
// comfortably under Postgres's 65535 per-statement limit, so the chunk size is
// about keeping one statement's parameter list sane rather than about that
// ceiling.
const INSERT_BATCH_ROWS = 200;

async function insertCreatures(client, worldId, rows) {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += INSERT_BATCH_ROWS) {
    const batch = rows.slice(i, i + INSERT_BATCH_ROWS);
    const params = [];
    const tuples = batch.map((c) => {
      const b = params.length;
      params.push(worldId, c.type, c.x, c.y, c.hp, c.facing, c.level, c.damage, c.defense);
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`;
    });
    await client.query(
      `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, level, damage, defense)
       VALUES ${tuples.join(',')}`,
      params,
    );
  }
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
  //
  // SOMET-244: vault chests (chests.js's insertVaultChest) hit the exact
  // same class of bug -- a spec can declare `chest: { guard_creature_type:
  // 'Wolf', ... }`, so a vault guard can just as easily have neither
  // type = 'Village Guard' nor a blocks_portal_id. home_x IS NOT NULL is the
  // general structural marker every guard shares (village, portal, and vault
  // alike all leash to a post via home_x/home_y; scattered/packed hostiles
  // from THIS module's own inserts below never set it), so sparing on it
  // covers vault guards too without adding a fourth special case per guard
  // kind. Caught by seed_map_vault_chests_db.test.js: without this, the vault
  // guard placed by the chest-stamping pass just above (applyMapSpec, before
  // this populateWorld loop) was deleted again in the very same transaction,
  // moments after being inserted.
  await client.query(
    'DELETE FROM world_creatures WHERE world_id = $1 AND type <> $2 '
    + 'AND blocks_portal_id IS NULL AND home_x IS NULL',
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
  // route already applied before this module existed. Guard-faction types
  // are placed exclusively via insertVillageGuards (anchored to a village
  // gate post); a guard rolled into the scatter/pack pool here would have no
  // home_x/home_y (withinLeash treats a null home as unconstrained), so it
  // would come out as a world-roaming, undroppable, unleashed 300hp
  // creature-hunter. Covered by world_population_db.test.js's "populateWorld
  // excludes guard-faction types from the wild-spawn pool".
  const hostileTypes = et.rows.filter((t) => (t.faction || 'hostile') !== 'guard');
  if (hostileTypes.length === 0) {
    await client.query('UPDATE worlds SET creature_count = 0 WHERE id = $1', [worldRow.id]);
    return { scattered: 0, packed: 0, total: 0 };
  }

  // A clamped world is a content problem, not a runtime error: the author
  // asked for more creatures than one population pass may place, and got
  // fewer. Silent truncation is what this replaces -- creature_count would
  // simply come out lower than the tier implies, indistinguishable from a
  // world deliberately authored thin. This sits after both early returns
  // above rather than right after resolveDensity: a world with no usable
  // creature types places nothing regardless of the ceiling, so the clamp
  // is not the story there, and warning about a scatter count that never
  // happens would assert a placement that never occurs.
  if (density.clamped) {
    console.warn(
      `[worldPopulation] world ${worldRow.id} (${worldRow.width}x${worldRow.height}, `
      + `density "${worldRow.density ?? 'normal'}") was clamped to `
      + `${density.scatterCount} scattered creatures by MAX_WORLD_CREATURES`,
    );
  }

  const tileTypes = await loadTileTypes(client);
  const villages = await fetchVillages(client, worldRow.id);
  const links = await fetchLinks(client, worldRow.id);
  const doorways = links.filter((l) => l.edge !== 'PORTAL').map((l) => l.edge);
  const biomes = await loadBiomes(client, worldRow.biomes);
  const cfg = buildWorldGenConfig({ row: worldRow, tileTypes, doorways, villages, biomes, links });

  const scatter = placeMapCreatures(cfg, density.scatterCount, hostileTypes, rngSeed);
  const packed = placeCreaturePacks(
    cfg, packSpecsFor(density, rngSeed), hostileTypes, rngSeed);

  // Persisted from scatter.length (what was actually placed), not
  // density.scatterCount (what was asked for), so worlds.creature_count keeps
  // meaning "how many scattered creatures this world holds" for the admin UI
  // and every existing reader even when placement ships short.
  await client.query('UPDATE worlds SET creature_count = $1 WHERE id = $2',
    [scatter.length, worldRow.id]);

  // creature_count never lies (it is written from what actually landed,
  // above), but nothing previously said so out loud. A wide safe_road_radius
  // or safe_rects can exhaust rejection sampling and ship a world well short
  // of its tier -- see the measured table in
  // migrations/1714440180000_world_safe_region.js -- and SOMET-289 will be
  // tuning that radius with no other feedback loop. One line, matching the
  // `join refused:` / `spawn: relocated character` style already used in
  // authority/server.js.
  if (scatter.length < density.scatterCount) {
    console.warn('populateWorld: scatter under-delivered for world', worldRow.name,
      `(requested ${density.scatterCount}, placed ${scatter.length})`);
  }

  await insertCreatures(client, worldRow.id, [...scatter, ...packed]);

  return { scattered: scatter.length, packed: packed.length, total: scatter.length + packed.length };
}

module.exports = { populateWorld, packSpecsFor, GUARD_TYPE };
