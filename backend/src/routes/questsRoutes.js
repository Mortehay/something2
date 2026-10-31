// backend/src/routes/questsRoutes.js
//
// Every character-scoped route is behind requireAuth and resolves the character
// through ownedCharacter(req.user.id, ...): a character id from the path or body
// is only ever honoured when it belongs to the signed-in account. Before this,
// anyone (signed in or not) could start, complete and pay out quests for any
// character id.
//
// There is deliberately no progress route. Progress is earned by the game
// (questsService.incrementQuestProgress, called server-side); a client-writable
// counter let a player set it to the target and claim the reward.
const express = require('express');
const { requireAuth } = require('../auth/middleware.js');
const { ownedCharacter } = require('../services/characters.js');
const {
  QuestError,
  listAllQuests,
  getCharacterQuests,
  startQuest,
  completeQuest,
  abandonQuest,
} = require('../services/questsService.js');

function sendError(res, err, what) {
  if (err instanceof QuestError) {
    return res.status(err.status).json({ ok: false, error: err.message });
  }
  console.error(`quests: ${what} failed:`, err);
  return res.status(500).json({ ok: false, error: `failed to ${what}` });
}

function createQuestsRouter(pool) {
  const router = express.Router();
  const guard = requireAuth(pool);

  // 403 for both "not yours" and "does not exist": a 404 for the second would
  // make this an oracle for which character ids are real (same as /api/progression).
  async function characterOr403(req, res, raw) {
    const character = await ownedCharacter(pool, req.user.id, raw);
    if (!character) {
      res.status(403).json({ ok: false, error: 'forbidden' });
      return null;
    }
    return character;
  }

  // GET /api/quests - the authored catalog (static, identical for everyone)
  router.get('/', async (req, res) => {
    try {
      const quests = await listAllQuests(pool);
      res.json({ ok: true, quests });
    } catch (err) {
      sendError(res, err, 'list quests');
    }
  });

  // GET /api/quests/character/:characterId - Character quest state & legacy choice
  router.get('/character/:characterId', guard, async (req, res) => {
    try {
      const character = await characterOr403(req, res, req.params.characterId);
      if (!character) return;
      const data = await getCharacterQuests(pool, character.id);
      res.json({ ok: true, ...data });
    } catch (err) {
      sendError(res, err, 'load character quests');
    }
  });

  // POST /api/quests/start - Start quest
  router.post('/start', guard, async (req, res) => {
    try {
      const { characterId, questKey, questId } = req.body || {};
      const character = await characterOr403(req, res, characterId);
      if (!character) return;
      const questState = await startQuest(pool, character.id, questKey || questId);
      res.json({ ok: true, questState });
    } catch (err) {
      sendError(res, err, 'start quest');
    }
  });

  // POST /api/quests/complete - Complete quest & optionally record Act IV legacy choice
  router.post('/complete', guard, async (req, res) => {
    try {
      const { characterId, questKey, questId, legacyChoice } = req.body || {};
      const character = await characterOr403(req, res, characterId);
      if (!character) return;
      const result = await completeQuest(pool, character.id, questKey || questId, legacyChoice);
      res.json({ ok: true, ...result });
    } catch (err) {
      sendError(res, err, 'complete quest');
    }
  });

  // POST /api/quests/abandon - drop an active quest (progress is lost)
  router.post('/abandon', guard, async (req, res) => {
    try {
      const { characterId, questKey, questId } = req.body || {};
      const character = await characterOr403(req, res, characterId);
      if (!character) return;
      await abandonQuest(pool, character.id, questKey || questId);
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err, 'abandon quest');
    }
  });

  return router;
}

module.exports = { createQuestsRouter };
