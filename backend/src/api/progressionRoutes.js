// The authenticated character-sheet API: GET the current progression bundle,
// POST an allocation, POST a respec. Thin by design -- every guard (unknown
// stat, insufficient points, insufficient gold, atomicity under concurrent
// requests) already lives in services/progressionStore.js and is already
// tested there. This file's only job is auth, request shape, and translating
// the store's { ok, reason } into an HTTP status.
//
// Every route acts on req.user.id -- set by requireAuth from the verified,
// revocation-checked token -- and NEVER on a user id read from the request
// body, path or query. That is the entire security property this file
// exists to enforce: without it, POST /api/progression/allocate with a
// body-supplied userId would let any authenticated account spend points (or
// respec) on someone else's character.
const express = require('express');
const { requireAuth } = require('../auth/middleware.js');
const { loadProgression, allocateStat, respec } = require('../services/progressionStore.js');
const { derivePlayerStats, xpFloor, xpToNext } = require('../services/playerStats.js');
const C = require('../services/progressionConstants.js');

module.exports = function progressionRoutes(pool) {
  const router = express.Router();
  const guard = requireAuth(pool);

  router.get('/', guard, async (req, res) => {
    try {
      const progression = await loadProgression(pool, req.user.id);
      res.status(200).json({
        progression,
        stats: derivePlayerStats(progression),
        xpFloor: xpFloor(progression.level),
        xpToNext: xpToNext(progression.level),
        respecCost: C.RESPEC_BASE * progression.level,
      });
    } catch (err) {
      console.error('progression fetch failed:', err);
      res.status(500).json({ error: 'failed to load progression' });
    }
  });

  router.post('/allocate', guard, async (req, res) => {
    try {
      // stat/count are handed to allocateStat exactly as received -- it
      // whitelists the stat key and validates the count itself (statKey
      // reaches it from an HTTP body, per its own comment). Re-validating
      // here would just be a second, driftable copy of the same guard.
      const { stat, count } = req.body || {};
      const r = await allocateStat(pool, req.user.id, stat, count);
      if (!r.ok) return res.status(400).json({ error: r.reason });
      return res.status(200).json({
        progression: r.progression,
        stats: derivePlayerStats(r.progression),
      });
    } catch (err) {
      console.error('allocate failed:', err);
      return res.status(500).json({ error: 'allocate failed' });
    }
  });

  router.post('/respec', guard, async (req, res) => {
    try {
      const r = await respec(pool, req.user.id);
      if (!r.ok) return res.status(402).json({ error: r.reason, cost: r.cost });
      return res.status(200).json({
        progression: r.progression,
        stats: derivePlayerStats(r.progression),
        gold: r.gold,
      });
    } catch (err) {
      console.error('respec failed:', err);
      return res.status(500).json({ error: 'respec failed' });
    }
  });

  return router;
};
