const { villageGatePosts, villageMerchantPost } = require('./mapService');
const { seedBaseCatalog } = require('./merchantStock');

// A village create/read/update caller may pick one of two ranges for width
// (columns) vs height (rows); a village that falls outside them is rejected
// by validateVillageBody in index.js and, later, by the map-spec validator.
// Both places import this single object so the numbers cannot drift apart.
const VILLAGE_LIMITS = { minW: 3, maxW: 8, minH: 3, maxH: 6 };

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
// transaction — village create/delete and the creature re-roll route all
// pass their transaction's client so this participates in it (F-007 /
// SOMET-187); regenerate isn't transactional and still passes the pool).
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

module.exports = { fetchVillages, createVillage, insertVillageGuards, GUARD_TYPE, VILLAGE_LIMITS };
