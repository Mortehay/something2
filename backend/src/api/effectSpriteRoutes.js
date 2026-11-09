// Sprite tab: generated effect strips for the batch-1 auras / bolts / impacts / beams.
// Every route sits behind adminGuard. The queue and the box loop live in services/effectSpriteJobs.js
// and services/effectDispatcher.js; this file is the HTTP face.
'use strict';
const express = require('express');
const jobs = require('../services/effectSpriteJobs.js');
const { BATCH_1, subjectOf, defaultPrompt, effectEstimate, approveColumns, effectTargetError } = require('../services/effectSprites.js');
const spritePrompts = require('../services/spritePrompts.js');
const defaultBoxCancels = require('../services/spriteBoxCancels.js');

const KINDS = ['projectile', 'burst', 'aura', 'beam'];
const tableOf = (subject_kind) => (subject_kind === 'aura' ? 'aura_effects' : 'vfx_effects');

function spriteOf(row) {
  if (!row || !row.sprite_image) return null;
  return {
    image: row.sprite_image, frames: row.sprite_frames, additive: row.sprite_additive,
    loop: row.sprite_loop ?? null, fps: row.sprite_fps ?? null, stretch: row.sprite_stretch ?? null,
  };
}

const INT4_MAX = 2147483647;

// How a finished candidate will play once approved: the same approveColumns approve writes, read
// from the job's box atlas (frames / fps_hint / loop), so preview == approved == game. null when
// the job has no image yet or its atlas cannot be approved.
function candidatePlay(job) {
  if (!job.image_key) return null;
  try {
    const c = approveColumns({ subject_kind: job.subject_kind, kind: job.kind, atlas: job.atlas,
      imageKey: job.image_key, frames: job.frames, blend: job.blend });
    return { frames: c.sprite_frames, loop: job.subject_kind === 'aura' ? true : c.sprite_loop, fps: c.sprite_fps ?? null };
  } catch (_) {
    return null;
  }
}

// deps: { box, loadProvider, boxCancels } -- only to cancel a box job a re-queue detached.
function effectSpriteRoutes(pool, adminGuard, dispatcher, { box = null, loadProvider = null, boxCancels = defaultBoxCancels } = {}) {
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

  // The prompt each subject will be drawn from: its active description, else
  // the colour-word default. One lookup per kind.
  async function promptsOf(rows) {
    const out = new Map();
    for (const kind of ['aura', 'vfx']) {
      const templates = new Map(BATCH_1.filter((s) => s.subject_kind === kind)
        .map((s) => { const row = rows.get(`${kind}|${s.name}`); return [s.name, defaultPrompt(s.name, row ? row.color : null)]; }));
      // eslint-disable-next-line no-await-in-loop
      const found = await spritePrompts.spritePromptsFor(pool, kind, templates);
      for (const [name, p] of found) out.set(`${kind}|${name}`, p);
    }
    return out;
  }

  router.get('/', async (_req, res) => {
    try {
      const [rows, latest] = await Promise.all([subjectRows(), jobs.latestBySubject(pool)]);
      const prompts = await promptsOf(rows);
      const subjects = BATCH_1.map((s) => {
        const key = `${s.subject_kind}|${s.name}`;
        const row = rows.get(key);
        const j = latest.get(key);
        const p = prompts.get(key);
        return {
          subject_kind: s.subject_kind, name: s.name, group: s.group, kind: s.kind, blend: s.blend,
          color: row ? row.color : null,
          default_prompt: defaultPrompt(s.name, row ? row.color : null),
          default_frames: s.frames, default_loop: s.loop,
          prompt: p.prompt, prompt_source: p.source,
          prompt_kind: s.subject_kind, prompt_key: s.name,
          missing: !row,
          sprite: spriteOf(row),
          job: j ? {
            id: j.id, status: j.status, prompt: j.prompt, image_key: j.image_key, frames: j.frames,
            loop: j.loop, needs_prompt: j.needs_prompt === true, updated_at: j.updated_at,
            error: j.error, predicted_seconds: j.predicted_seconds, sheet_seconds: j.sheet_seconds,
            play: candidatePlay(j),
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

  async function cancelDropped(rows) {
    const provider = await loadProvider();
    if (!provider) return;
    for (const j of rows) {
      // eslint-disable-next-line no-await-in-loop
      const r = await boxCancels.request(pool, provider, { boxJobId: j.dropped_box_job_id, subject: j.subject_name, source: 'options-changed' }, { box });
      if (!r.ok) console.error(`effects: could not cancel box job ${j.dropped_box_job_id}: ${r.error}`);
    }
  }

  router.post('/jobs', async (req, res) => {
    try {
      const targets = req.body && req.body.targets;
      if (!Array.isArray(targets) || !targets.length) return res.status(400).json({ error: 'targets must be a non-empty list' });
      const regenerate = req.body.regenerate;
      if (regenerate !== undefined && typeof regenerate !== 'boolean') {
        return res.status(400).json({ error: 'regenerate must be true or false' });
      }
      const rows = await subjectRows();
      const todo = [];
      const skipped = [];
      for (const t of targets) {
        const s = t && subjectOf(t.subject_kind, t.name);
        if (!s) return res.status(400).json({ error: `${t && t.name} is not a batch-1 effect` });
        const prompt = typeof t.prompt === 'string' ? t.prompt.trim() : t.prompt;
        if (prompt != null && (typeof prompt !== 'string' || prompt.length < 1 || prompt.length > 1000)) {
          return res.status(400).json({ error: 'prompt must be 1-1000 characters' });
        }
        const shapeError = effectTargetError(s, { frames: t.frames, loop: t.loop });
        if (shapeError) return res.status(400).json({ error: shapeError });
        const row = rows.get(`${s.subject_kind}|${s.name}`);
        if (!row) { skipped.push({ subject_kind: s.subject_kind, name: s.name, reason: 'no such effect in this database' }); continue; }
        // No prompt: enqueue resolves it (the active description, else the
        // colour-word default). Only an admin-edited prompt is sent explicitly.
        todo.push({
          subject_kind: s.subject_kind, name: s.name, prompt: prompt == null ? null : prompt,
          frames: t.frames ?? undefined, loop: t.loop ?? undefined, needsPrompt: regenerate === true,
        });
      }
      const r = await jobs.enqueue(pool, todo);
      // A re-queue that changed a queued job detached the box job it kept; stop
      // that strip on the box. Best effort, never awaited by the answer.
      const dropped = r.queued.filter((j) => j.dropped_box_job_id);
      if (dropped.length && box && loadProvider) cancelDropped(dropped).catch((e) => console.error('effects: cancelling detached box jobs failed:', e.message));
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
    // effect_sprite_jobs.id is int4: a larger id cannot exist (and would make pg throw).
    if (Number(req.params.id) > INT4_MAX) return res.status(404).json({ error: 'job not found' });
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
