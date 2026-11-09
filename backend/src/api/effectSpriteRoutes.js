// Sprite tab: generated effect strips for the batch-1 auras / bolts / impacts / beams.
// Every route sits behind adminGuard. The queue and the box loop live in services/effectSpriteJobs.js
// and services/effectDispatcher.js; this file is the HTTP face.
'use strict';
const express = require('express');
const jobs = require('../services/effectSpriteJobs.js');
const { BATCH_1, subjectOf, defaultPrompt, effectEstimate } = require('../services/effectSprites.js');

const KINDS = ['projectile', 'burst', 'aura', 'beam'];
const tableOf = (subject_kind) => (subject_kind === 'aura' ? 'aura_effects' : 'vfx_effects');

function spriteOf(row) {
  if (!row || !row.sprite_image) return null;
  return {
    image: row.sprite_image, frames: row.sprite_frames, additive: row.sprite_additive,
    loop: row.sprite_loop ?? null, fps: row.sprite_fps ?? null, stretch: row.sprite_stretch ?? null,
  };
}

function effectSpriteRoutes(pool, adminGuard, dispatcher, { now = Date.now } = {}) {
  void now;
  const router = express.Router();
  router.use(adminGuard);
  router.use(express.json());

  async function subjectRows() {
    const out = new Map();
    for (const kind of ['aura', 'vfx']) {
      const { rows } = await pool.query(
        kind === 'aura'
          ? 'SELECT name, color, sprite_image, sprite_frames, sprite_additive, sprite_fps FROM aura_effects'
          : 'SELECT name, color, sprite_image, sprite_frames, sprite_additive, sprite_loop, sprite_fps, sprite_stretch FROM vfx_effects');
      for (const r of rows) out.set(`${kind}|${r.name}`, r);
    }
    return out;
  }

  router.get('/', async (_req, res) => {
    try {
      const [rows, latest] = await Promise.all([subjectRows(), jobs.latestBySubject(pool)]);
      const subjects = BATCH_1.map((s) => {
        const key = `${s.subject_kind}|${s.name}`;
        const row = rows.get(key);
        const j = latest.get(key);
        return {
          subject_kind: s.subject_kind, name: s.name, group: s.group, kind: s.kind, blend: s.blend,
          color: row ? row.color : null,
          default_prompt: defaultPrompt(s.name, row ? row.color : null),
          missing: !row,
          sprite: spriteOf(row),
          job: j ? {
            id: j.id, status: j.status, prompt: j.prompt, image_key: j.image_key, frames: j.frames,
            error: j.error, predicted_seconds: j.predicted_seconds, sheet_seconds: j.sheet_seconds,
          } : null,
        };
      });
      const eta = {};
      for (const k of KINDS) eta[k] = effectEstimate(k, await jobs.measuredSeconds(pool, k));
      res.json({ subjects, eta, dispatcher: dispatcher.status() });
    } catch (err) {
      console.error('effects: list failed:', err.message);
      res.status(500).json({ error: 'could not list effects' });
    }
  });

  router.post('/jobs', async (req, res) => {
    try {
      const targets = req.body && req.body.targets;
      if (!Array.isArray(targets) || !targets.length) return res.status(400).json({ error: 'targets must be a non-empty list' });
      const rows = await subjectRows();
      const todo = [];
      const skipped = [];
      for (const t of targets) {
        const s = t && subjectOf(t.subject_kind, t.name);
        if (!s) return res.status(400).json({ error: `${t && t.name} is not a batch-1 effect` });
        if (t.prompt != null && (typeof t.prompt !== 'string' || t.prompt.length < 1 || t.prompt.length > 1000)) {
          return res.status(400).json({ error: 'prompt must be 1-1000 characters' });
        }
        const row = rows.get(`${s.subject_kind}|${s.name}`);
        if (!row) { skipped.push({ subject_kind: s.subject_kind, name: s.name, reason: 'no such effect in this database' }); continue; }
        todo.push({ subject_kind: s.subject_kind, name: s.name, prompt: t.prompt == null ? defaultPrompt(s.name, row.color) : t.prompt });
      }
      const r = await jobs.enqueue(pool, todo);
      const queued = r.queued.map((j) => ({ id: j.id, subject_kind: j.subject_kind, name: j.subject_name, predicted_seconds: j.predicted_seconds }));
      res.status(202).json({ queued, skipped: [...skipped, ...r.skipped] });
      if (queued.length) Promise.resolve(dispatcher.kick()).catch((e) => console.error('effects: kick failed:', e.message));
    } catch (err) {
      console.error('effects: enqueue failed:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'could not queue effects' });
    }
  });

  router.post('/jobs/:id/approve', async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'job id must be an integer' });
    try {
      const r = await jobs.approve(pool, Number(req.params.id));
      const { rows } = await pool.query(
        `SELECT sprite_image, sprite_frames, sprite_additive, sprite_fps${r.subject_kind === 'aura' ? '' : ', sprite_loop, sprite_stretch'}
           FROM ${tableOf(r.subject_kind)} WHERE name = $1`, [r.name]);
      res.json({ subject_kind: r.subject_kind, name: r.name, sprite: spriteOf(rows[0]) });
    } catch (err) {
      if (err && err.status) return res.status(err.status).json({ error: err.message });
      console.error('effects: approve failed:', err.message);
      res.status(500).json({ error: 'could not approve' });
    }
  });

  router.post('/dispatch', (_req, res) => {
    Promise.resolve(dispatcher.kick()).catch((e) => console.error('effects: kick failed:', e.message));
    res.status(202).json({ running: true });
  });

  return router;
}

module.exports = effectSpriteRoutes;
