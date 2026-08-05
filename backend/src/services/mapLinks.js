const { oppositeEdge } = require('./mapService');

// This world's outgoing links, joined to each target's bounds (for compass
// arrival geometry -- portal rows carry their own to_x/to_y and ignore
// to_width/to_height entirely).
async function fetchLinks(pool, worldId) {
  const r = await pool.query(
    `SELECT ml.id, ml.edge, ml.to_world_id, w.width AS to_width, w.height AS to_height,
            ml.from_x, ml.from_y, ml.to_x, ml.to_y
     FROM map_links ml JOIN worlds w ON w.id = ml.to_world_id
     WHERE ml.from_world_id = $1`,
    [worldId],
  );
  return r.rows;
}

// Bidirectional upsert: (from,edge,to) and its mirror (to,opposite,from).
async function setLink(pool, fromId, edge, toId) {
  const insert = `INSERT INTO map_links (from_world_id, edge, to_world_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (from_world_id, edge) DO UPDATE SET to_world_id = EXCLUDED.to_world_id`;
  await pool.query(insert, [fromId, edge, toId]);
  await pool.query(insert, [toId, oppositeEdge(edge), fromId]);
}

// Bidirectional delete: (from,edge) and its mirror (to,opposite).
async function clearLink(pool, fromId, edge) {
  const cur = await pool.query(
    'SELECT to_world_id FROM map_links WHERE from_world_id = $1 AND edge = $2',
    [fromId, edge],
  );
  await pool.query('DELETE FROM map_links WHERE from_world_id = $1 AND edge = $2', [fromId, edge]);
  if (cur.rows[0]) {
    await pool.query('DELETE FROM map_links WHERE from_world_id = $1 AND edge = $2',
      [cur.rows[0].to_world_id, oppositeEdge(edge)]);
  }
}

// A portal has no "opposite edge" to compute the way a compass link does --
// there is no rotation that turns (from_x,from_y)->(to_x,to_y) into its
// return trip. The mirror is instead a second PORTAL row with from/to
// (and their coordinates) swapped outright. Returns the id of the FORWARD
// row (from -> to), which is what a guard's blocks_portal_id should
// reference: guards defend the departure side of a specific staircase.
async function setPortalLink(pool, fromId, fromX, fromY, toId, toX, toY) {
  const insert = `INSERT INTO map_links (from_world_id, edge, to_world_id, from_x, from_y, to_x, to_y)
     VALUES ($1, 'PORTAL', $2, $3, $4, $5, $6)
     ON CONFLICT (from_world_id, from_x, from_y)
       WHERE edge = 'PORTAL'
       DO UPDATE SET to_world_id = EXCLUDED.to_world_id, to_x = EXCLUDED.to_x, to_y = EXCLUDED.to_y
     RETURNING id`;
  const forward = await pool.query(insert, [fromId, toId, fromX, fromY, toX, toY]);
  await pool.query(insert, [toId, fromId, toX, toY, fromX, fromY]);
  return { id: forward.rows[0].id };
}

// Bidirectional delete, keyed by the exact source tile rather than an edge
// name -- a world can have many PORTAL rows, so "delete the portal FROM
// this world" is ambiguous without a tile.
async function clearPortalLink(pool, fromId, fromX, fromY) {
  const cur = await pool.query(
    `SELECT to_world_id, to_x, to_y FROM map_links
      WHERE from_world_id = $1 AND edge = 'PORTAL' AND from_x = $2 AND from_y = $3`,
    [fromId, fromX, fromY],
  );
  await pool.query(
    `DELETE FROM map_links WHERE from_world_id = $1 AND edge = 'PORTAL' AND from_x = $2 AND from_y = $3`,
    [fromId, fromX, fromY],
  );
  if (cur.rows[0]) {
    const { to_world_id, to_x, to_y } = cur.rows[0];
    await pool.query(
      `DELETE FROM map_links WHERE from_world_id = $1 AND edge = 'PORTAL' AND from_x = $2 AND from_y = $3`,
      [to_world_id, to_x, to_y],
    );
  }
}

module.exports = { fetchLinks, setLink, clearLink, setPortalLink, clearPortalLink };
