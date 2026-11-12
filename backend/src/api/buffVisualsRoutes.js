// backend/src/api/buffVisualsRoutes.js
// How character buffs draw (buff_visuals). Modelled on auraEffectsRoutes.js: an open GET the game
// client reads, admin-only writes. Rows are fixed by the skill catalog, so there is no POST or
// DELETE: a PUT upserts the one row of a visual buff. Rules live in services/buffVisuals.js.
const express = require('express');
const { requireAdmin } = require('../auth/middleware.js');
const { listBuffVisuals, saveBuffVisual, setBuffDisplayForAll } = require('../services/buffVisuals.js');
const { getSettings } = require('../services/gameSettings.js');

const MAIN = 'buff_visual_main_opacity';
const OTHER = 'buff_visual_other_opacity';

function fail(res, err, fallback) {
  if (err.status === 400 || err.status === 404) return res.status(err.status).json({ error: err.message });
  if (err.code === '23514') return res.status(400).json({ error: `rejected by ${err.constraint}` });
  console.error(err);
  return res.status(500).json({ error: fallback });
}

module.exports = function buffVisualsRoutes(pool) {
  const router = express.Router();
  const guard = requireAdmin(pool);

  router.get('/', async (req, res) => {
    try {
      const [visuals, s] = await Promise.all([listBuffVisuals(pool), getSettings(pool, [MAIN, OTHER])]);
      res.json({ visuals, settings: { main_opacity: s[MAIN], other_opacity: s[OTHER] } });
    } catch (err) { fail(res, err, 'Failed to fetch buff visuals'); }
  });

  // SOMET-769: one display for every visual buff. Before /:skillId, which would 404 'display'.
  router.put('/display', guard, async (req, res) => {
    const b = req.body || {};
    if (!('display' in b)) return res.status(400).json({ error: 'display is required' });
    try {
      const updated = await setBuffDisplayForAll(pool, b.display);
      res.json({ display: b.display, updated });
    } catch (err) { fail(res, err, 'Failed to set buff display'); }
  });

  router.put('/:skillId', guard, async (req, res) => {
    try {
      res.json(await saveBuffVisual(pool, req.params.skillId, req.body || {}));
    } catch (err) { fail(res, err, 'Failed to save buff visual'); }
  });

  return router;
};
