// Sprite tab: generated effect strips for every vfx_effects / aura_effects row and visual buff (effectCatalog.js).
// Every route sits behind adminGuard. The queue and the box loop live in services/effectSpriteJobs.js
// and services/effectDispatcher.js; this file is the HTTP face.
'use strict';
const express = require('express');
const jobs = require('../services/effectSpriteJobs.js');
const { effectEstimate, approveColumns, effectTargetError, effectMaxFrames } = require('../services/effectSprites.js');
const { loadEffectCatalog, subjectPrompt } = require('../services/effectCatalog.js');
const { EFFECT_KINDS, kindOf, alwaysLoops } = require('../services/effectKinds.js');
const { listBuffVisuals } = require('../services/buffVisuals.js');
const { listStatusVisuals, STATUS_COLOR } = require('../services/statusVisuals.js');
const spritePrompts = require('../services/spritePrompts.js');
const defaultBoxCancels = require('../services/spriteBoxCancels.js');

const KINDS = ['projectile', 'burst', 'aura', 'beam'];

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
    return { frames: c.sprite_frames, loop: alwaysLoops(job.subject_kind) ? true : c.sprite_loop, fps: c.sprite_fps ?? null };
  } catch (_) {
    return null;
  }
}

// deps: { box, loadProvider, boxCancels } -- only to cancel a box job a re-queue detached.
function effectSpriteRoutes(pool, adminGuard, dispatcher, { box = null, loadProvider = null, boxCancels = defaultBoxCancels } = {}) {
  const router = express.Router();
  router.use(adminGuard);
  router.use(express.json());

  // Each subject's row with its colour and sprite columns. A visual buff reads merged over its
  // defaults, so one with no buff_visuals row yet is not missing.
  async function subjectRows() {
    const out = new Map();
    for (const [kind, k] of Object.entries(EFFECT_KINDS)) {
      // A status row has no colour column: it draws amber, and its list rows say `key`.
      const rows = kind === 'buff'
        ? await listBuffVisuals(pool)
        : kind === 'status'
          ? (await listStatusVisuals(pool)).map((r) => ({ ...r, subject_key: r.key, color: STATUS_COLOR }))
          : (await pool.query(`SELECT ${k.keyCol}, color, ${k.spriteCols.join(', ')} FROM ${k.table}`)).rows;
      for (const r of rows) out.set(`${kind}|${r[k.keyCol]}`, r);
    }
    return out;
  }

  // The prompt each subject will be drawn from: its active description, else
  // the colour-word default. One lookup per kind.
  async function promptsOf(subjects) {
    const out = new Map();
    for (const kind of Object.keys(EFFECT_KINDS)) {
      const templates = new Map(subjects.filter((s) => s.subject_kind === kind).map((s) => [s.name, subjectPrompt(s)]));
      // eslint-disable-next-line no-await-in-loop
      const found = await spritePrompts.spritePromptsFor(pool, kind, templates);
      for (const [name, p] of found) out.set(`${kind}|${name}`, p);
    }
    return out;
  }

  // A job whose effect row was renamed or deleted since it was queued: still listed, from the
  // settings the job was queued with, so the tab shows it (missing) instead of failing.
  const orphanSubject = (j) => ({
    subject_kind: j.subject_kind, name: j.subject_name, group: 'Not used yet',
    kind: j.kind, frames: j.frames, size: j.size, loop: j.loop, blend: j.blend,
    topDown: false, color: null, shape: null, retired: false,
  });

  router.get('/', async (_req, res) => {
    try {
      const [catalog, rows, latest] = await Promise.all([loadEffectCatalog(pool), subjectRows(), jobs.latestBySubject(pool)]);
      const listed = new Set(catalog.map((s) => `${s.subject_kind}|${s.name}`));
      const orphans = [...latest.entries()].filter(([key]) => !listed.has(key)).map(([, j]) => orphanSubject(j));
      const all = [...catalog, ...orphans];
      const prompts = await promptsOf(all);
      const subjects = all.map((s) => {
        const key = `${s.subject_kind}|${s.name}`;
        const row = rows.get(key);
        const j = latest.get(key);
        const p = prompts.get(key);
        return {
          subject_kind: s.subject_kind, name: s.name, group: s.group, kind: s.kind, blend: s.blend,
          placement: s.placement ?? null, // buffs: 'ground' | 'body'; vfx/aura have none
          color: row ? row.color : null,
          default_prompt: subjectPrompt(s),
          default_frames: s.frames, default_loop: s.loop, max_frames: effectMaxFrames(s),
          retired: s.retired,
          prompt: p.prompt, prompt_source: p.source, prompt_origin: p.origin ?? null,
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
      const catalog = new Map((await loadEffectCatalog(pool)).map((s) => [`${s.subject_kind}|${s.name}`, s]));
      const todo = [];
      for (const t of targets) {
        const s = t && catalog.get(`${t.subject_kind}|${t.name}`);
        if (!s) return res.status(400).json({ error: `${t && t.name} is not an effect` });
        const prompt = typeof t.prompt === 'string' ? t.prompt.trim() : t.prompt;
        if (prompt != null && (typeof prompt !== 'string' || prompt.length < 1 || prompt.length > 1000)) {
          return res.status(400).json({ error: 'prompt must be 1-1000 characters' });
        }
        // Regenerate writes a new prompt; an edited one would be thrown away.
        if (prompt != null && regenerate === true) {
          return res.status(400).json({ error: 'choose either an edited prompt or Regenerate' });
        }
        const shapeError = effectTargetError(s, { frames: t.frames, loop: t.loop });
        if (shapeError) return res.status(400).json({ error: shapeError });
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
      res.status(202).json({ queued, skipped: r.skipped });
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
      const k = kindOf(r.subject_kind);
      const { rows } = await pool.query(
        `SELECT ${k.spriteCols.join(', ')} FROM ${k.table} WHERE ${k.keyCol} = $1`, [r.name]);
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
