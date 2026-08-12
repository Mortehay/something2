const { villageGatePosts, villageMerchantPost } = require('./mapService');
const { seedBaseCatalog } = require('./merchantStock');
const { MAP_TILE_SIZE } = require('../authority/coords');

// A village create/read/update caller may pick one of two ranges for width
// (columns) vs height (rows); a village that falls outside them is rejected
// by validateVillageBody in index.js and, later, by the map-spec validator.
// Both places import this single object so the numbers cannot drift apart.
const VILLAGE_LIMITS = { minW: 3, maxW: 8, minH: 3, maxH: 6 };

// The spawn/respawn point must land on an INTERIOR tile of the village box.
// stampVillage walls the whole perimeter (only the single gate tile is
// passable), so a spawn on the ring teleports the player *into* a wall tile:
// respawn-at-village then drops them inside the wall with no way out
// (SOMET-153, shipped live on three p5-descent hubs).
//
// ONE rule, TWO callers: validateVillageBody in src/index.js (the HTTP admin
// API) and validateMapSpec in seeds/mapSpec.js (the seed path). The seed path
// had NO spawn check at all -- scripts/seed-map.js calls createVillage
// directly, bypassing the route -- which is exactly how the broken villages
// got written. Both now import this function, for the same
// cannot-drift-apart reason VILLAGE_LIMITS is shared rather than duplicated.
//
// Returns null when the spawn is legal, otherwise a message describing what
// is wrong. Fields are the snake_case shape used by both the API body and the
// map spec's `village` object.
function villageSpawnError(village) {
  const { min_row, min_col, width, height, spawn_x, spawn_y } = village || {};
  if (!Number.isFinite(spawn_x) || !Number.isFinite(spawn_y)) {
    return 'spawn_x and spawn_y are required';
  }
  const sCol = Math.floor(spawn_x / MAP_TILE_SIZE);
  const sRow = Math.floor(spawn_y / MAP_TILE_SIZE);
  // Interior = the box minus its one-tile wall ring. Written as inclusive
  // bounds so the error can name them; identical to the strict-inequality
  // form (sRow > min_row && sRow < min_row + height - 1) for integer tiles.
  const loRow = min_row + 1;
  const hiRow = min_row + height - 2;
  const loCol = min_col + 1;
  const hiCol = min_col + width - 2;
  const inInterior = sRow >= loRow && sRow <= hiRow && sCol >= loCol && sCol <= hiCol;
  if (inInterior) return null;
  return 'spawn point must be inside the village interior — '
    + `spawn (${spawn_x},${spawn_y}) lands on tile (row ${sRow}, col ${sCol}), `
    + `but the interior is rows ${loRow}..${hiRow}, cols ${loCol}..${hiCol}`;
}

async function fetchVillages(pool, worldId) {
  const r = await pool.query(
    `SELECT id, min_row, min_col, width, height, gate_edge, spawn_x, spawn_y, merchant_x, merchant_y
       FROM villages WHERE world_id = $1 ORDER BY created_at ASC`,
    [worldId],
  );
  return r.rows.map((v) => ({
    id: v.id,
    minRow: v.min_row, minCol: v.min_col,
    width: v.width, height: v.height,
    gateEdge: v.gate_edge,
    spawnX: v.spawn_x, spawnY: v.spawn_y,
    merchantX: v.merchant_x == null ? null : Number(v.merchant_x),
    merchantY: v.merchant_y == null ? null : Number(v.merchant_y),
  }));
}

// Two guards per village, standing on the interior tiles flanking the gate.
// home_x/home_y is the post: the authority leashes a guard to it.
// `db` is any queryable (the module-level pool, or a connected client mid-
// transaction — village create/delete, the creature re-roll route, and the
// regenerate-terrain route (SOMET-252) all pass their transaction's client
// so this participates in it, F-007 / SOMET-187).
const GUARD_TYPE = 'Village Guard';
async function insertVillageGuards(db, worldId, villages) {
  for (const v of villages) {
    for (const post of villageGatePosts(v)) {
      await db.query(
        `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, home_x, home_y)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [worldId, GUARD_TYPE, post.x, post.y, 300, 'S', post.x, post.y],
      );
    }
  }
}

// The three dependent writes a village needs to be playable: the row itself,
// its gate guards, and its merchant's base catalog. `client` is the caller's
// transaction client (village create/delete and the seed applier all run
// this inside their own BEGIN/COMMIT/ROLLBACK) so this function owns none of
// the transaction handling or error mapping -- only the write sequence.
async function createVillage(client, worldId, village) {
  const { min_row, min_col, width, height, gate_edge, spawn_x, spawn_y } = village;
  const mpost = villageMerchantPost({
    minRow: min_row, minCol: min_col, width, height, gateEdge: gate_edge,
  });

  const ins = await client.query(
    `INSERT INTO villages (world_id, min_row, min_col, width, height, gate_edge, spawn_x, spawn_y, merchant_x, merchant_y)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [worldId, min_row, min_col, width, height, gate_edge, spawn_x, spawn_y, mpost.x, mpost.y],
  );
  const row = ins.rows[0];
  await insertVillageGuards(client, worldId, [{
    minRow: row.min_row, minCol: row.min_col,
    width: row.width, height: row.height, gateEdge: row.gate_edge,
  }]);
  await seedBaseCatalog(client, worldId, row.id);
  return row;
}

module.exports = {
  fetchVillages, createVillage, insertVillageGuards, GUARD_TYPE, VILLAGE_LIMITS, villageSpawnError,
};
