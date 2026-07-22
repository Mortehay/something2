const { oppositeEdge } = require('./mapService');

// This world's outgoing links, joined to each target's bounds (for arrival geometry).
async function fetchLinks(pool, worldId) {
  const r = await pool.query(
    `SELECT ml.edge, ml.to_world_id, w.width AS to_width, w.height AS to_height
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

module.exports = { fetchLinks, setLink, clearLink };
