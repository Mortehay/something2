// backend/src/api/passiveTreeRoutes.js
//
// The tree graph itself. Player-authenticated and read-only: the graph is the
// same for everyone, so there is nothing per-user to leak and nothing to write.
//
// The client caches this for the session (it is ~1800 nodes and ~2100 edges and
// changes only when an admin edits a node or the seeder runs), so the response
// carries a `version` the client can compare rather than re-parsing blindly.
//
// T9 adds the admin list/update routes on top of this router.
const express = require('express');
const { requireAuth } = require('../auth/middleware.js');
const { loadTree } = require('../services/passiveTreeStore.js');

module.exports = function passiveTreeRoutes(pool) {
  const router = express.Router();
  const guard = requireAuth(pool);

  router.get('/', guard, async (req, res) => {
    try {
      const tree = await loadTree(pool);
      return res.status(200).json({
        nodes: tree.nodes,
        edges: tree.edges,
        // Not a hash: the count pair is enough to notice a reseed, and hashing
        // 1806 rows on every request to save a client parse is the wrong trade.
        version: `${tree.nodes.length}:${tree.edges.length}`,
      });
    } catch (err) {
      console.error('passive tree fetch failed:', err);
      return res.status(500).json({ error: 'failed to load passive tree' });
    }
  });

  return router;
};
