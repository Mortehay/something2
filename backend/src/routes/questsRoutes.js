// backend/src/routes/questsRoutes.js
const express = require('express');
const {
  listAllQuests,
  getCharacterQuests,
  startQuest,
  completeQuest,
  incrementQuestProgress,
} = require('../services/questsService.js');

function createQuestsRouter(pool) {
  const router = express.Router();

  // GET /api/quests - List all quests
  router.get('/', async (req, res) => {
    try {
      const quests = await listAllQuests(pool);
      res.json({ ok: true, quests });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /api/quests/character/:characterId - Character quest state & legacy choice
  router.get('/character/:characterId', async (req, res) => {
    try {
      const characterId = parseInt(req.params.characterId, 10);
      const data = await getCharacterQuests(pool, characterId);
      res.json({ ok: true, ...data });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /api/quests/start - Start quest
  router.post('/start', async (req, res) => {
    try {
      const { characterId, questKey, questId } = req.body;
      const questState = await startQuest(pool, characterId, questKey || questId);
      res.json({ ok: true, questState });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // POST /api/quests/complete - Complete quest & optionally record Act IV legacy choice
  router.post('/complete', async (req, res) => {
    try {
      const { characterId, questKey, questId, legacyChoice } = req.body;
      const result = await completeQuest(pool, characterId, questKey || questId, legacyChoice);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // POST /api/quests/progress - Increment quest objective progress count
  router.post('/progress', async (req, res) => {
    try {
      const { characterId, questKey, questId, amount } = req.body;
      const updated = await incrementQuestProgress(pool, characterId, questKey || questId, amount || 1);
      res.json({ ok: true, progressState: updated });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createQuestsRouter };
