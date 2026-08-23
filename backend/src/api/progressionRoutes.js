// The authenticated character-sheet API: GET the current progression bundle,
// POST a respec. Thin by design -- every guard (insufficient gold, atomicity
// under concurrent requests) already lives in services/progressionStore.js and
// is already tested there. This file's only job is auth, request shape, and
// translating the store's { ok, reason } into an HTTP status.
//
// POST /allocate is GONE (SOMET-470): stat points no longer exist. Its
// replacement is POST /passives/:nodeId (SOMET-475), which spends one
// passive point on one tree node; POST /respec now resets the tree.
//
// SOMET-486: every derivePlayerStats call below passes `character.classPools`
// -- the class base pools resolveCharacter already has in hand from
// ownedCharacter. Omitting it on any one of the three would make the character
// sheet report a Mage's max HP as 100 while the world it is standing in gives
// it 75, which is the same advertise-vs-play split 486 exists to close, just
// moved from character select to the sheet.
//
// NOTHING here computes a stat. `loadProgression` returns the row already
// composed by statComposition.js, so every field below is lifted off that one
// object -- `effective`, `sources` and `modifiers` are never re-summed, on
// either side of the wire (contract §6.2, and the drift CharacterSheet.jsx's
// F2 header describes).
//
// Every route acts on req.user.id -- set by requireAuth from the verified,
// revocation-checked token -- and NEVER on a user id read from the request
// body, path or query. That is the entire security property this file
// exists to enforce: without it, POST /api/progression/respec with a
// body-supplied userId would let any authenticated account respec someone
// else's character.
const express = require('express');
const { requireAuth } = require('../auth/middleware.js');
const { loadProgression } = require('../services/progressionStore.js');
const { allocateNode, respecPassives, respecQuote } = require('../services/passiveTreeStore.js');
const { derivePlayerStats, xpFloor, xpToNext } = require('../services/playerStats.js');
const { ownedCharacter } = require('../services/characters.js');

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

  // SOMET-257 made progression per-character, so every route here needs a
  // character id as well as the authenticated account. It is read from the
  // request (query for GET, body for POST) and then CHECKED against
  // req.user.id -- a client-supplied id is never trusted, and there is no
  // "default to the account's first character" fallback, which would silently
  // spend one character's points on another.
  //
  // Returns the character, or sends the response and returns null.
  async function resolveCharacter(req, res) {
    const raw = req.query.character_id ?? (req.body || {}).character_id;
    if (raw == null) {
      res.status(400).json({ error: 'character_id is required' });
      return null;
    }
    const character = await ownedCharacter(pool, req.user.id, raw);
    if (!character) {
      res.status(403).json({ error: 'forbidden' });
      return null;
    }
    return character;
  }

  router.get('/', guard, async (req, res) => {
    try {
      const character = await resolveCharacter(req, res);
      if (!character) return undefined;
      const progression = await loadProgression(pool, character.id);
      // The respec cost, the gold it is measured against and the verdict all
      // come from the server (contract §6.4). T8's overlay renders
      // `respecDisabled` rather than recomputing `respec_base_gold x level`,
      // which is the exact local-copy drift that made every click 402.
      const quote = await respecQuote(pool, req.user.id, progression.level);
      return res.status(200).json({
        progression,
        stats: derivePlayerStats(progression, character.classPools),
        xpFloor: xpFloor(progression.level),
        xpToNext: xpToNext(progression.level),
        respecCost: quote.respecCost,
        gold: quote.gold,
        respecDisabled: quote.respecDisabled,
        // Lifted out of `progression` as well as left inside it: HTTP callers
        // read them from the top level, the websocket single-writer path reads
        // them from inside. One source, two views, no recomputation.
        effective: progression.effective,
        passivePoints: progression.passivePoints,
        allocatedNodeIds: progression.allocatedNodeIds,
        sources: progression.sources,
        modifiers: progression.modifiers,
      });
    } catch (err) {
      console.error('progression fetch failed:', err);
      res.status(500).json({ error: 'failed to load progression' });
    }
  });

  // One node per request, id in the PATH (contract §3). The store owns every
  // guard -- invalid id, unknown node, start node, already allocated, no
  // points, not reachable -- exactly as the old /allocate delegated to
  // allocateStat.
  router.post('/passives/:nodeId', guard, async (req, res) => {
    try {
      const character = await resolveCharacter(req, res);
      if (!character) return undefined;
      const r = await allocateNode(pool, character.id, req.params.nodeId);
      if (!r.ok) return res.status(400).json({ error: r.reason });
      const progression = await loadProgression(pool, character.id);
      const stats = derivePlayerStats(progression, character.classPools);
      // Best-effort, same contract as before: this is what sends the ordered
      // websocket `progression` frame the client treats as its ONLY writer of
      // progression state (CharacterSheet.jsx's F1 header). The HTTP body
      // below is for the caller's own error handling; the client must not
      // write it into Game.progression.
      refreshLivePlayerStats(req.user.id, progression, stats);
      return res.status(200).json({ progression, stats });
    } catch (err) {
      console.error('passive allocate failed:', err);
      return res.status(500).json({ error: 'allocate failed' });
    }
  });

  router.post('/respec', guard, async (req, res) => {
    try {
      const character = await resolveCharacter(req, res);
      if (!character) return undefined;
      // Both ids: the allocation reset is per-character, the gold that pays
      // for it is per-account.
      const r = await respecPassives(pool, req.user.id, character.id);
      if (!r.ok) return res.status(402).json({ error: r.reason, cost: r.cost });
      const progression = await loadProgression(pool, character.id);
      const stats = derivePlayerStats(progression, character.classPools);
      refreshLivePlayerStats(req.user.id, progression, stats);
      return res.status(200).json({ progression, stats, gold: r.gold });
    } catch (err) {
      console.error('respec failed:', err);
      return res.status(500).json({ error: 'respec failed' });
    }
  });

  return router;
};
