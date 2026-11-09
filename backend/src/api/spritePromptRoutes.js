// Sprite tab: per-row prompt actions for creatures, hero appearances and
// effects. Regenerate asks the box's text model once (no waiting: a busy model
// is a 409 the admin can retry), an edit saves a new Sprite-tab version, and
// Revert puts the sprite lane back on the template. Props are excluded
// (spec §3). The prompt lane's rules live in services/spritePrompts.js.
'use strict';
const express = require('express');
const spritePrompts = require('../services/spritePrompts.js');
const subjectDescriber = require('../services/subjectDescriber.js');

const NOT_A_PROP = 'prompt regeneration is for creatures, heroes and effects';

// The template the sprite lane draws from without a description. Same rule as
// optionsForEntity (a blank entity prompt falls back to the name).
function templateOf(kind, subject) {
  if (kind === 'entity') return String((subject.row && subject.row.prompt) || '').trim() || subject.name;
  return subject.basePrompt;
}

function spritePromptRoutes(pool, adminGuard, { describer = subjectDescriber } = {}) {
  const router = express.Router();
  router.use(adminGuard);
  router.use(express.json());

  // The subject, or an answer already sent. Express has URL-decoded :key.
  async function subjectFor(req, res) {
    const { kind, key } = req.params;
    if (!spritePrompts.PROMPT_KINDS.includes(kind)) {
      res.status(400).json({ error: 'unknown prompt kind' });
      return null;
    }
    if (kind === 'entity') {
      const { rows: [e] } = await pool.query('SELECT is_creature, is_playable FROM entity_types WHERE name = $1', [key]);
      if (e && e.is_creature !== true && e.is_playable !== true) {
        res.status(400).json({ error: NOT_A_PROP });
        return null;
      }
    }
    const subject = await spritePrompts.describerSubject(pool, kind, key);
    if (!subject) {
      res.status(404).json({ error: `${kind} "${key}" not found` });
      return null;
    }
    return subject;
  }

  const fail = (res, err, what) => {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error(`sprite prompts: ${what} failed:`, err);
    return res.status(500).json({ error: `could not ${what} the prompt` });
  };

  router.post('/:kind/:key/regenerate', async (req, res) => {
    let subject;
    try {
      subject = await subjectFor(req, res);
    } catch (err) {
      return fail(res, err, 'regenerate');
    }
    if (!subject) return undefined;
    const { kind, key } = req.params;
    try {
      // One attempt: the describer's own errors (busy included) come back unchanged.
      const { text, model } = await spritePrompts.regeneratePrompt(pool, kind, key, { describer, subject });
      return res.json({ kind, key, prompt: text, source: 'description', model: model ?? null });
    } catch (err) {
      if (err && err.status) return res.status(err.status).json({ error: err.message });
      if (err && err.busy) return res.status(409).json({ error: `text model busy: ${err.message}` });
      console.error('sprite prompts: regenerate failed:', err);
      return res.status(502).json({ error: (err && err.message) || 'text model failed' });
    }
  });

  router.put('/:kind/:key', async (req, res) => {
    try {
      const subject = await subjectFor(req, res);
      if (!subject) return undefined;
      const { kind, key } = req.params;
      const text = req.body && typeof req.body.text === 'string' ? req.body.text : '';
      const saved = await spritePrompts.savePrompt(pool, kind, key, text);
      return res.status(201).json({ prompt: saved.text, source: 'description' });
    } catch (err) {
      return fail(res, err, 'save');
    }
  });

  // Back to the template (owner ruling: whatever wrote the active description).
  // A subject whose sprite prompt is already the template (a creature never
  // opted in from the Sprite tab) has nothing to revert: its art-console
  // description is left alone.
  router.delete('/:kind/:key', async (req, res) => {
    try {
      const subject = await subjectFor(req, res);
      if (!subject) return undefined;
      const { kind, key } = req.params;
      const template = templateOf(kind, subject);
      const current = (await spritePrompts.spritePromptsFor(pool, kind, new Map([[key, template]]))).get(key);
      let cleared = false;
      if (current.source !== 'template') cleared = (await spritePrompts.revertPrompt(pool, kind, key)).cleared === true;
      return res.json({ cleared, prompt: template, source: 'template' });
    } catch (err) {
      return fail(res, err, 'revert');
    }
  });

  return router;
}

module.exports = spritePromptRoutes;
