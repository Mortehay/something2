// backend/src/api/statusVisualsRoutes.js
// How timed statuses draw (status_visuals): an open GET the game client reads. Rows are fixed by
// the migration and their art is written by the Sprite tab's approve, so there are no writes here.
const express = require('express');
const { listStatusVisuals } = require('../services/statusVisuals.js');

module.exports = function statusVisualsRoutes(pool) {
  const router = express.Router();
  router.get('/', async (req, res) => {
    try {
      res.json(await listStatusVisuals(pool));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to fetch status visuals' });
    }
  });
  return router;
};
