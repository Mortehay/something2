// SOMET-309: creature respawn. A death enqueues a creature_respawns row (see
// authority/loot.js); this module drains due rows back into world_creatures.
//
// Deliberately NOT part of worldPopulation.js. That module is wipe-and-refill
// -- it opens by DELETEing every wild creature in a world and places a
// complete fresh set -- which is the opposite lifecycle to incremental top-up,
// and folding a hot per-death path into a seeding module would couple them for
// no gain.

const { placeMapCreatures, CREATURE_BASE_DAMAGE, isBoundedWorld } = require('./mapService');
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
async function respawnDueCreatures(pool, {
  getWorld, getPlayers, onSpawn = () => {}, limit = 200,
} = {}) {
  const due = await pool.query(
    `SELECT id, world_id, type, x, y, level FROM creature_respawns
      WHERE respawn_at <= now() ORDER BY respawn_at LIMIT $1`,
    [limit],
  );

  let spawned = 0;
  for (const row of due.rows) {
    try {
      const world = getWorld(row.world_id);
      if (!world) continue; // not loaded this pass; stays due, retried later

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
      const players = getPlayers(row.world_id);

      // Prefer the tile it died on. Relocate rather than defer when a player
      // is standing there: deferring would mean the more someone farms one
      // spot, the less it gives them -- the opposite of this feature's point.
      let pos = null;
      if (isClearOfPlayers(row.x, row.y, players)) {
        pos = { x: row.x, y: row.y };
      } else {
        const seed = Math.floor(Math.random() * 2 ** 31);
        const candidates = placeMapCreatures(world, FALLBACK_CANDIDATES, [t], seed);
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
// Enqueues immediately-due rows rather than inserting creatures directly, so
// there is exactly one spawn path and the player-distance rule applies to
// backfilled creatures too. The cost is that placement runs twice for these
// rows (once here to pick a tile, once in the sweep) -- bounded, because this
// runs at most once per world load.
//
// Packs are deliberately excluded from the target: resolveDensity's pack
// counts are re-rolled per populate, worlds.creature_count records only the
// scattered figure, and treating packs as a floor would make this oscillate.
// The backstop restores the scatter baseline; packs are a seeding-time
// flourish that does not regenerate.
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
