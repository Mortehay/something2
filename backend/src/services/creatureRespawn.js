// SOMET-309: creature respawn. A death enqueues a creature_respawns row (see
// authority/loot.js); this module drains due rows back into world_creatures.
//
// Deliberately NOT part of worldPopulation.js. That module is wipe-and-refill
// -- it opens by DELETEing every wild creature in a world and places a
// complete fresh set -- which is the opposite lifecycle to incremental top-up,
// and folding a hot per-death path into a seeding module would couple them for
// no gain.

const { placeMapCreatures, CREATURE_BASE_DAMAGE, isBoundedWorld, worldConfig } = require('./mapService');
const { scaleCreature } = require('./creatureLevel');
const { resolveDensity } = require('./densityTiers');

// The delay between a creature dying and its replacement becoming due.
const RESPAWN_DELAY_MS = 30000;

// The sweep's own interval. NOT itemSweepMs, which is 60000: draining a
// 30-second queue on a 60-second timer would make respawns take 30-90s and
// silently undo the pacing this feature was tuned for.
const CREATURE_SWEEP_MS = 10000;

// World px. MAP_TILE_SIZE is 100, so this is 10 tiles. The viewport shows
// roughly 15x15 tiles, so this keeps a spawn off the middle of someone's
// screen without pushing it so far that a cleared area never refills.
const RESPAWN_MIN_PLAYER_DISTANCE = 1000;

// True when no player is closer than minDistance to (x, y).
//
// Compares squared distances so the hot path takes no Math.sqrt. Strictly
// less-than: a player at exactly minDistance does not block the position, so
// the boundary belongs to the spawn.
function isClearOfPlayers(x, y, players, minDistance = RESPAWN_MIN_PLAYER_DISTANCE) {
  const min2 = minDistance * minDistance;
  for (const p of players) {
    const dx = p.x - x;
    const dy = p.y - y;
    if (dx * dx + dy * dy < min2) return false;
  }
  return true;
}

// How many candidate tiles to ask placeMapCreatures for when the recorded
// position is blocked. More than one because placeMapCreatures does not know
// about players -- it rejects on terrain, village safe zones, safe_road_radius
// and safe_rects only -- so its first answer can still land next to someone.
const FALLBACK_CANDIDATES = 5;

// Drains due creature_respawns rows back into world_creatures.
//
// Modelled on chests.js's respawnDueFieldChests, deliberately: same injected
// getWorld serving only LOADED worlds, same per-row try/catch, same onSpawn
// patch contract, same test seam on the server. Two sweep idioms for two
// respawning things would be one too many.
//
// getWorld returns null for a world that is not currently loaded, and that row
// simply stays due for a later pass. The sweep must never load a world itself:
// nothing but a socket close handler evicts one, so a background load would
// leak a permanently-loaded empty world.
//
// `loadedWorldIds` is what keeps that "stays due" behaviour from starving the
// whole feature (final review, Critical C1). The window is ordered oldest-first
// and capped at `limit`, so rows the sweep CANNOT action -- ones whose world is
// unloaded -- would otherwise sit permanently at the head of every pass. A
// player who kills something and leaves before the 30s delay elapses orphans a
// row that way, and across ~86 worlds those accumulate: once `limit` of them
// exist system-wide, the window contains nothing but orphans and no respawn
// ever fires again, in any world, with nothing logged. Filtering in SQL means
// the window only ever contains actionable rows. (enqueueDeficit's `pending`
// subtraction makes it worse, not better: a world holding orphans computes a
// deficit near zero, so the backstop cannot rescue it either.)
//
// Empty means the authority has no world loaded at all: there is nothing this
// pass could act on, so it does not query.
async function respawnDueCreatures(pool, {
  getWorld, getPlayers, onSpawn = () => {}, limit = 200, loadedWorldIds = [],
} = {}) {
  const worldIds = [...loadedWorldIds];
  if (worldIds.length === 0) return 0;

  const due = await pool.query(
    `SELECT id, world_id, type, x, y, level FROM creature_respawns
      WHERE respawn_at <= now() AND world_id = ANY($2::uuid[])
      ORDER BY respawn_at LIMIT $1`,
    [limit, worldIds],
  );

  // Grouped by world_id, respawn_at order preserved WITHIN each group (the
  // SELECT above already sorted the whole window that way, and Map iterates
  // groups in first-insertion order, so this is a stable partition, not a
  // reorder of the fetched window). Every row the query returned is still
  // processed exactly once either way, so this does not reopen the
  // starvation gap `loadedWorldIds` exists to close (see the header comment
  // above) -- that guarantee comes from the SQL WHERE clause bounding the
  // window to loaded worlds, not from the order rows are actioned in.
  //
  // The grouping exists so the expensive part of relocation -- see the `cfg`
  // comment below -- happens once per world per sweep pass instead of once
  // per row (SOMET-350 final review, FIX 2: this loop was measured paying an
  // O(width*height) BFS + normalization pass, ~3.2ms on a 224x224 world, on
  // EVERY row that needed relocating, up to `limit` times per sweep).
  const byWorld = new Map();
  for (const row of due.rows) {
    if (!byWorld.has(row.world_id)) byWorld.set(row.world_id, []);
    byWorld.get(row.world_id).push(row);
  }

  let spawned = 0;
  for (const [worldId, rows] of byWorld) {
    // Defence in depth, not the primary filter: the query above already
    // restricts the window to loaded worlds, but a world can be evicted
    // between that query and these rows being actioned.
    const world = getWorld(worldId);
    if (!world) continue; // unloaded since the query; every row here stays due, retried later

    // worldConfig() returns a fresh object every call, and mapService's
    // SAFE_CTX/DENSITY_FIELD caches are keyed on THAT object's identity (see
    // mapService.js's own comments on both WeakMaps) -- so building cfg once
    // here and passing it into every placeMapCreatures call below for this
    // world lets those caches hit for every row after the first, instead of
    // rebuilding on every row. Scoped to this one pass over this one world
    // and discarded when the loop moves on; never attached to `world` or
    // `worldId`, so unlike a cache keyed on the world itself this raises no
    // stale-cache question across a world re-roll -- the very next sweep
    // pass calls worldConfig() again and gets a config as fresh as before
    // this change.
    const cfg = worldConfig(world);

    for (const row of rows) {
      try {
        // Full row: placeMapCreatures reads .hp/.defense/.resistances off each
        // allowed type, and scaleCreature needs hp/defense too. A name-only row
        // would silently respawn every creature at the 10hp/0-defense fallback.
        const et = await pool.query(
          `SELECT id, name, hp, defense, resistances FROM entity_types
            WHERE name = $1 AND is_creature = true`,
          [row.type],
        );
        if (et.rowCount === 0) {
          // The catalog no longer has this creature. Retrying forever would pin
          // a permanently-failing row at the head of every sweep; drop it.
          await pool.query('DELETE FROM creature_respawns WHERE id = $1', [row.id]);
          continue;
        }
        const t = et.rows[0];
        // Fetched per row, deliberately NOT hoisted alongside cfg above: real
        // wall-clock time passes between rows in this inner loop (the
        // entity_types SELECT and the claim/insert transaction below both
        // await), during which a live world's players keep moving. Reusing
        // one snapshot for the whole group would relocate later rows in this
        // world against stale positions -- cfg has no such freshness
        // requirement (it depends on the map, not on players), which is
        // exactly why only cfg is hoisted.
        const players = getPlayers(row.world_id);

        // Prefer the tile it died on. Relocate rather than defer when a player
        // is standing there: deferring would mean the more someone farms one
        // spot, the less it gives them -- the opposite of this feature's point.
        let pos = null;
        if (isClearOfPlayers(row.x, row.y, players)) {
          pos = { x: row.x, y: row.y };
        } else {
          const seed = Math.floor(Math.random() * 2 ** 31);
          const candidates = placeMapCreatures(world, FALLBACK_CANDIDATES, [t], seed, undefined, cfg);
          // placeMapCreatures is used purely as a legal-tile finder here; its
          // own level roll is discarded so the respawn keeps the level it died
          // at rather than re-rolling into a different band.
          const clear = candidates.find((c) => isClearOfPlayers(c.x, c.y, players));
          if (!clear) continue; // no legal tile clear of players this pass; retry later
          pos = { x: clear.x, y: clear.y };
        }

        const scaled = scaleCreature(
          { hp: t.hp || 10, damage: CREATURE_BASE_DAMAGE, defense: Number(t.defense ?? 0) || 0 },
          row.level,
        );

        const client = await pool.connect();
        let creatureId = null;
        try {
          await client.query('BEGIN');
          // Gated exactly like commitCreatureDeath's own DELETE: rowCount === 1
          // means THIS pass claimed the row. Two concurrent sweeps seeing the
          // same due row must produce exactly one creature, and the loser must
          // insert nothing.
          const claim = await client.query('DELETE FROM creature_respawns WHERE id = $1', [row.id]);
          if (claim.rowCount !== 1) {
            await client.query('ROLLBACK');
            continue;
          }
          const ins = await client.query(
            `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, level, damage, defense)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
            [row.world_id, t.name, pos.x, pos.y, scaled.hp, 'S', row.level, scaled.damage, scaled.defense],
          );
          await client.query('COMMIT');
          creatureId = ins.rows[0].id;
        } catch (err) {
          // client.release() does NOT roll back -- without this the connection
          // returns to the pool holding an open transaction.
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }

        spawned += 1;
        // Counted above: the DB write committed, so this creature EXISTS
        // regardless of whether the caller's best-effort cache sync throws.
        // Awaited so the server's test seam observes the injection.
        await onSpawn({ worldId: row.world_id, creatureId });
      } catch (err) {
        // One bad row must not abort the pass -- every other due row still gets
        // its turn, and this one stays due for a retry.
        console.error(`respawnDueCreatures: failed to respawn row ${row.id}:`, err);
      }
    }
  }
  return spawned;
}

// The load-time backstop.
//
// A per-death queue only knows about deaths that happen after it ships. The
// creatures alive when this feature landed have no queue rows, and a world
// drained before that would stay drained forever. This closes that gap and
// makes the system self-healing: a population lost to ANY cause, including
// causes not yet known, comes back the next time a player enters.
//
// This function only ENQUEUES -- it never drains. Enqueuing immediately-due
// rows rather than inserting creatures directly means there is exactly one
// spawn path (respawnDueCreatures) and the player-distance rule applies to
// backfilled creatures too -- but only because the caller does NOT also
// drain them from inside loadWorld. A joining player is not added to
// entry.world.players until after loadWorld returns, so a drain run from
// here would see no players at all and isClearOfPlayers would be vacuously
// true for every row, defeating the one guarantee this feature makes.
// loadWorld enqueues only; the regular creatureRespawnSweep timer (10s,
// registered independently of any world load) does the actual draining,
// by which point the join has completed and the distance check is real.
// SOMET-309 Task 6 review, round 1.
//
// WHAT THE ARITHMETIC ACTUALLY DOES (final review, I1). This is NOT an exact
// refill to the seeded population, and the numbers are not comparable like for
// like:
//
//   target = resolveDensity(...).scatterCount   -- SCATTER creatures only
//   live   = count(world_creatures WHERE home_x IS NULL ...)
//
// but worldPopulation.js inserts BOTH scattered creatures and pack members with
// home_x NULL, so `live` counts pack members too while `target` does not. The
// floor this restores therefore sits BELOW the seeded total by roughly the
// world's pack budget, and a world must lose that many creatures before the
// backstop enqueues anything at all -- up to ~72 at `swarm` density (6 packs of
// up to 12). That dead zone is deliberate under-delivery, not an exact refill:
// packs are re-rolled on every populate and have no persistent representation
// (no column, no row, nothing to count), so making them part of the target
// would mean inventing one, and a target built on a fresh random pack roll
// would make this oscillate. Restoring a conservative floor is the trade taken;
// a world will not be re-filled to its seeded headcount by this path alone.
//
// CONCURRENCY (final review, I2). This is count-then-insert with no lock, which
// is safe ONLY because a single authority process owns the database. Two
// processes would both read the same `live`/`pending`, both compute the same
// deficit and both insert, overshooting to 2x target. A multi-process
// deployment must wrap the count-then-insert in a pg advisory lock keyed by
// world id (pg_advisory_xact_lock). Deliberately not built now -- there is one
// authority process.
async function enqueueDeficit(pool, { worldRow, world }) {
  if (!isBoundedWorld(worldRow)) return 0;

  const allowedNames = Array.isArray(worldRow.allowed_creature_types)
    ? worldRow.allowed_creature_types : [];
  if (allowedNames.length === 0) return 0;

  const et = await pool.query(
    `SELECT name, hp, defense, resistances, faction FROM entity_types
      WHERE is_creature = true AND name = ANY($1::text[])`,
    [allowedNames],
  );
  // Same exclusion populateWorld applies: a guard-faction type rolled into the
  // wild pool would have no home_x, so withinLeash would treat it as
  // unconstrained -- a world-roaming, undroppable creature-hunter.
  const hostileTypes = et.rows.filter((t) => (t.faction || 'hostile') !== 'guard');
  if (hostileTypes.length === 0) return 0;

  const target = resolveDensity(worldRow.density, worldRow.width, worldRow.height).scatterCount;

  const live = await pool.query(
    `SELECT count(*)::int AS n FROM world_creatures
      WHERE world_id = $1 AND home_x IS NULL AND blocks_portal_id IS NULL`,
    [worldRow.id],
  );
  const pending = await pool.query(
    'SELECT count(*)::int AS n FROM creature_respawns WHERE world_id = $1', [worldRow.id],
  );

  const deficit = target - live.rows[0].n - pending.rows[0].n;
  if (deficit <= 0) return 0;

  const seed = Math.floor(Math.random() * 2 ** 31);
  const placed = placeMapCreatures(world, deficit, hostileTypes, seed);
  if (placed.length === 0) return 0;

  // One multi-row INSERT: a 55-row backfill should not be 55 round trips on
  // the path a player is waiting behind.
  const params = [];
  const tuples = placed.map((c) => {
    const b = params.length;
    params.push(worldRow.id, c.type, c.x, c.y, c.level);
    return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5}, now())`;
  });
  await pool.query(
    `INSERT INTO creature_respawns (world_id, type, x, y, level, respawn_at)
     VALUES ${tuples.join(',')}`,
    params,
  );

  return placed.length;
}

module.exports = {
  isClearOfPlayers,
  respawnDueCreatures,
  enqueueDeficit,
  RESPAWN_DELAY_MS, CREATURE_SWEEP_MS, RESPAWN_MIN_PLAYER_DISTANCE,
};
