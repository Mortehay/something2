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

// `refreshLivePlayerStats(userId, progression, stats)` pushes a successful
// write into the live authority session (SOMET-242 follow-up: allocating a
// point or respeccing mid-session must move the HUD/character sheet without
// a reload, not just the database). Defaults to a no-op so every existing
// caller/test that builds this router with one argument keeps working
// unchanged, and so a route never 500s when there is no authority attached
// at all (true of the whole test harness, and of index.js itself before
// `attachAuthority` runs) — the real forwarder index.js passes in already
// carries its own `?.` fallback for exactly that case.
module.exports = function progressionRoutes(pool, refreshLivePlayerStats = () => false) {
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
      const stats = derivePlayerStats(r.progression);
      // Best-effort: refuses/no-ops silently (no live session, no authority
      // attached, player at hp<=0) — the write above already succeeded and
      // the HTTP response below reflects it regardless.
      refreshLivePlayerStats(req.user.id, r.progression, stats);
      return res.status(200).json({ progression: r.progression, stats });
    } catch (err) {
      console.error('allocate failed:', err);
      return res.status(500).json({ error: 'allocate failed' });
    }
  });

  router.post('/respec', guard, async (req, res) => {
    try {
      const r = await respec(pool, req.user.id);
      if (!r.ok) return res.status(402).json({ error: r.reason, cost: r.cost });
      const stats = derivePlayerStats(r.progression);
      refreshLivePlayerStats(req.user.id, r.progression, stats);
      return res.status(200).json({ progression: r.progression, stats, gold: r.gold });
    } catch (err) {
      console.error('respec failed:', err);
      return res.status(500).json({ error: 'respec failed' });
    }
  });

  return router;
};
