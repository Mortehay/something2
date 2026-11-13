// backend/src/api/statusVisualsRoutes.js
// How timed statuses draw (status_visuals): an open GET the game client reads. Rows are fixed by
// the migration and their art is written by the Sprite tab's approve. SOMET-769: the one admin
// write is a row's `display` (code | sprite), singly or for every row.
const express = require('express');
const { requireAdmin } = require('../auth/middleware.js');
const { listStatusVisuals, setStatusDisplay } = require('../services/statusVisuals.js');
const { displayError, setDisplayForAll } = require('../services/effectDisplay.js');

const { serveMap, wantsWeb, webArt } = require('../services/webArtServe.js');

module.exports = function statusVisualsRoutes(pool) {
  const router = express.Router();
  const guard = requireAdmin(pool);

  router.get('/', async (req, res) => {
    try {
      const rows = await listStatusVisuals(pool);
      if (!wantsWeb(req)) return res.json(rows);
      const map = await serveMap(pool);
      res.json(Array.isArray(rows) ? rows.map((r) => webArt(map, r)) : rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to fetch status visuals' });
    }
  });

  const bodyError = (b) => displayError(b) || (!('display' in (b || {})) ? 'display is required' : null);

  // Before /:key, so 'display' is never read as a row key.
  router.put('/display', guard, async (req, res) => {
    const bad = bodyError(req.body);
    if (bad) return res.status(400).json({ error: bad });
    try {
      const updated = await setDisplayForAll(pool, 'status', req.body.display);
      res.json({ display: req.body.display, updated });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to set status display' });
    }
  });

  router.put('/:key', guard, async (req, res) => {
    const bad = bodyError(req.body);
    if (bad) return res.status(400).json({ error: bad });
    try {
      const row = await setStatusDisplay(pool, req.params.key, req.body.display);
      if (!row) return res.status(404).json({ error: 'Status visual not found' });
      res.json(row);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to save status visual' });
    }
  });

  return router;
};
