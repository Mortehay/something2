// backend/src/routes/achievementsRoutes.js
//
// The achievements journal. Same scoping rule as the quest routes: a character id
// is only honoured when it belongs to the signed-in account (403 otherwise, for
// "not yours" and "does not exist" alike, so it is not an oracle for ids).
const express = require('express');
const { requireAuth } = require('../auth/middleware.js');
const { ownedCharacter } = require('../services/characters.js');
const { getJournal, setActiveTitle } = require('../services/achievements.js');

function createAchievementsRouter(pool) {
  const router = express.Router();
  const guard = requireAuth(pool);

  async function characterOr403(req, res, raw) {
    const character = await ownedCharacter(pool, req.user.id, raw);
    if (!character) {
      res.status(403).json({ ok: false, error: 'forbidden' });
      return null;
    }
    return character;
  }

  // GET /api/achievements/character/:characterId
  router.get('/character/:characterId', guard, async (req, res) => {
    try {
      const character = await characterOr403(req, res, req.params.characterId);
      if (!character) return;
      res.json({ ok: true, ...(await getJournal(pool, character.id)) });
    } catch (err) {
      console.error('achievements: load failed:', err);
      res.status(500).json({ ok: false, error: 'failed to load achievements' });
    }
  });

  // POST /api/achievements/title  { characterId, title: string|null }
  router.post('/title', guard, async (req, res) => {
    try {
      const { characterId, title } = req.body || {};
      const character = await characterOr403(req, res, characterId);
      if (!character) return;
      if (title !== null && title !== undefined && typeof title !== 'string') {
        return res.status(400).json({ ok: false, error: 'title must be a string or null' });
      }
      const result = await setActiveTitle(pool, character.id, title);
      res.status(result.ok ? 200 : 400).json(result);
    } catch (err) {
      console.error('achievements: set title failed:', err);
      res.status(500).json({ ok: false, error: 'failed to set title' });
    }
  });

  return router;
}

module.exports = { createAchievementsRouter };
