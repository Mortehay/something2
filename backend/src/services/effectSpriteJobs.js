// The effect_sprite_jobs queue (generated effect strips). One active job per subject is held
// by the partial unique index; every function takes a pg Pool/Client as `db`.
'use strict';
const crypto = require('node:crypto');
const { readAtlas, approveColumns, effectEstimate, effectJobShape, defaultPrompt } = require('./effectSprites.js');
const { loadEffectCatalog } = require('./effectCatalog.js');
const spritePrompts = require('./spritePrompts.js');

const randomSeed = () => crypto.randomInt(1, 2 ** 31 - 1);

async function measuredSeconds(db, kind) {
  const { rows } = await db.query(
    `SELECT sheet_seconds FROM (
       SELECT sheet_seconds FROM effect_sprite_jobs
        WHERE kind = $1 AND status IN ('done','approved') AND sheet_seconds > 0
        ORDER BY finished_at DESC NULLS LAST, id DESC LIMIT 10) t`,
    [kind],
  );
  if (rows.length < 3) return null;
  const v = rows.map((r) => Number(r.sheet_seconds)).sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// A target may carry its own prompt; without one, the prompt is resolved here (an active
// description for effects, else the colour-word default), so no caller can forget it.
// `subjects` is the effect list keyed `${subject_kind}|${name}`.
async function resolvePrompts(db, targets, subjects) {
  const out = new Map();
  for (const kind of ['aura', 'vfx']) {
    const missing = targets.filter((t) => t.subject_kind === kind && t.prompt == null && subjects.has(`${kind}|${t.name}`));
    if (missing.length === 0) continue;
    const templates = new Map(missing.map((t) => {
      const s = subjects.get(`${kind}|${t.name}`);
      return [t.name, defaultPrompt(s.name, s.color, { topDown: s.topDown })];
    }));
    // eslint-disable-next-line no-await-in-loop
    const found = await spritePrompts.spritePromptsFor(db, kind, templates);
    for (const t of missing) out.set(t, found.get(t.name).prompt);
  }
  return out;
}

async function enqueue(db, targets, { seed = randomSeed } = {}) {
  const queued = [];
  const skipped = [];
  const subjects = new Map((await loadEffectCatalog(db)).map((s) => [`${s.subject_kind}|${s.name}`, s]));
  const resolved = await resolvePrompts(db, targets, subjects);
  for (const t of targets) {
    const s = subjects.get(`${t.subject_kind}|${t.name}`);
    if (!s) { skipped.push({ subject_kind: t.subject_kind, name: t.name, reason: 'unknown subject' }); continue; }
    const shape = effectJobShape(s, { frames: t.frames, loop: t.loop });
    const predicted = Math.max(1, Math.round(effectEstimate(s.kind, await measuredSeconds(db, s.kind)).typical));
    try {
      const { rows } = await db.query(
        `INSERT INTO effect_sprite_jobs
           (subject_kind, subject_name, prompt, kind, frames, size, loop, blend, seed, predicted_seconds, needs_prompt)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [s.subject_kind, s.name, t.prompt == null ? resolved.get(t) : t.prompt, s.kind, shape.frames, s.size, shape.loop, s.blend,
          typeof seed === 'function' ? seed() : seed, predicted, t.needsPrompt === true],
      );
      queued.push(rows[0]);
    } catch (err) {
      if (!(err && err.code === '23505')) throw err;
      // A queued, not-yet-claimed job is updated in place (like the creature lane's re-queue);
      // a running one, or one that would not change, is skipped. A pending regeneration survives
      // unless an explicit prompt arrives. Without an explicit prompt or a regeneration the job
      // takes the freshly resolved prompt, so a per-row Regenerate / edit made since it was
      // queued is what gets drawn.
      const explicit = t.prompt != null;
      const fresh = explicit ? t.prompt : (resolved.get(t) ?? null);
      const { rows: [upd] } = await db.query(
        `UPDATE effect_sprite_jobs SET
            prompt = CASE WHEN $3::boolean THEN $4
                          WHEN NOT $5::boolean AND NOT needs_prompt AND $4 IS NOT NULL THEN $4
                          ELSE prompt END,
            needs_prompt = CASE WHEN $3::boolean THEN $5::boolean ELSE needs_prompt OR $5::boolean END,
            frames = CASE WHEN $6::boolean THEN $7::int ELSE frames END,
            loop = CASE WHEN $8::boolean THEN $9::boolean ELSE loop END,
            -- any change reaches here only when it alters the drawing: the old box job (kept by
            -- requeue after an unreachable box) would draw the old spec, so it is dropped.
            box_job_id = NULL, running_since = NULL,
            updated_at = now()
          WHERE subject_kind = $1 AND subject_name = $2 AND status = 'queued'
            AND ( ($3::boolean AND (prompt IS DISTINCT FROM $4 OR needs_prompt IS DISTINCT FROM $5::boolean))
               OR (NOT $3::boolean AND $5::boolean AND NOT needs_prompt)
               OR (NOT $3::boolean AND NOT $5::boolean AND NOT needs_prompt AND $4 IS NOT NULL
                   AND prompt IS DISTINCT FROM $4)
               OR ($6::boolean AND frames IS DISTINCT FROM $7::int)
               OR ($8::boolean AND loop IS DISTINCT FROM $9::boolean) )
          RETURNING *, (SELECT o.box_job_id FROM effect_sprite_jobs o WHERE o.id = effect_sprite_jobs.id) AS dropped_box_job_id`,
        [s.subject_kind, s.name, explicit, fresh, t.needsPrompt === true,
          t.frames != null, shape.frames, t.loop != null || s.kind === 'aura' || s.kind === 'burst', shape.loop]);
      if (upd) queued.push(upd);
      else skipped.push({ subject_kind: s.subject_kind, name: s.name, reason: 'already queued' });
    }
  }
  return { queued, skipped };
}

async function claimNext(db) {
  const { rows } = await db.query(
    `UPDATE effect_sprite_jobs SET status = 'running', running_since = NULL, updated_at = now()
      WHERE id = (SELECT id FROM effect_sprite_jobs WHERE status = 'queued' AND NOT needs_prompt
                   ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`,
  );
  return rows[0] || null;
}

// The prompt phase: the oldest queued job whose prompt is still to be written.
async function nextPromptJob(db) {
  const { rows } = await db.query(
    `SELECT * FROM effect_sprite_jobs WHERE status = 'queued' AND needs_prompt ORDER BY created_at, id LIMIT 1`);
  return rows[0] || null;
}

// Null when the job left the queue meanwhile.
async function promptWritten(db, id, prompt) {
  const { rows } = await db.query(
    `UPDATE effect_sprite_jobs SET prompt = $2, needs_prompt = false, updated_at = now()
      WHERE id = $1 AND status = 'queued' AND needs_prompt RETURNING *`, [id, prompt]);
  return rows[0] || null;
}

const markSeenRunning = (db, id) => db.query(
  'UPDATE effect_sprite_jobs SET running_since = COALESCE(running_since, now()), updated_at = now() WHERE id = $1', [id]);

const setBoxJob = (db, id, boxJobId) => db.query(
  'UPDATE effect_sprite_jobs SET box_job_id = $2, updated_at = now() WHERE id = $1', [id, boxJobId]);

const markDone = (db, id, { imageKey, atlas }) => db.query(
  `UPDATE effect_sprite_jobs
      SET status = 'done', image_key = $2, atlas = $3, finished_at = now(), updated_at = now(), error = NULL,
          sheet_seconds = CASE WHEN running_since IS NULL THEN NULL
                               ELSE round(EXTRACT(epoch FROM now() - running_since))::int END
    WHERE id = $1`,
  [id, imageKey, atlas == null ? null : JSON.stringify(atlas)]);

const fail = (db, id, message) => db.query(
  `UPDATE effect_sprite_jobs SET status = 'failed', error = $2, finished_at = now(), updated_at = now() WHERE id = $1`,
  [id, String(message).slice(0, 2000)]);

// The prompt phase's failure: only while the job still waits for its prompt. A job re-queued
// in place meanwhile (an explicit prompt during a long busy wait) is left alone.
async function promptFailed(db, id, message) {
  const { rows } = await db.query(
    `UPDATE effect_sprite_jobs SET status = 'failed', error = $2, finished_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'queued' AND needs_prompt RETURNING *`,
    [id, String(message).slice(0, 2000)]);
  return rows[0] || null;
}

const requeue = (db, id) => db.query(
  `UPDATE effect_sprite_jobs SET status = 'queued', running_since = NULL, updated_at = now() WHERE id = $1`, [id]);

async function latestBySubject(db) {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (subject_kind, subject_name) * FROM effect_sprite_jobs
      ORDER BY subject_kind, subject_name, created_at DESC, id DESC`);
  return new Map(rows.map((r) => [`${r.subject_kind}|${r.subject_name}`, r]));
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

async function approve(db, id) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: [job] } = await client.query('SELECT * FROM effect_sprite_jobs WHERE id = $1 FOR UPDATE', [id]);
    if (!job) throw httpError(404, 'job not found');
    if (job.status !== 'done' || !job.image_key) throw httpError(409, 'only a finished job with an image can be approved');
    if (job.kind === 'projectile' || job.kind === 'beam') {
      const a = readAtlas(job.atlas, { kind: job.kind, frames: job.frames, blend: job.blend });
      if (!a.tailPivot) throw httpError(409, 'box atlas pivot is not the tail end; the renderer anchors strips at the tail');
    }
    let columns;
    try {
      columns = approveColumns({ subject_kind: job.subject_kind, kind: job.kind, atlas: job.atlas,
        imageKey: job.image_key, frames: job.frames, blend: job.blend });
    } catch (err) { throw httpError(409, err.message); }
    const table = job.subject_kind === 'aura' ? 'aura_effects' : 'vfx_effects';
    const keys = Object.keys(columns);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    if (job.subject_kind === 'aura') sets.push('updated_at = now()');
    const { rowCount } = await client.query(
      `UPDATE ${table} SET ${sets.join(', ')} WHERE name = $1`,
      [job.subject_name, ...keys.map((k) => columns[k])]);
    if (!rowCount) throw httpError(404, `${job.subject_kind} "${job.subject_name}" no longer exists`);
    await client.query(
      `UPDATE effect_sprite_jobs SET status = 'done', updated_at = now()
        WHERE subject_kind = $1 AND subject_name = $2 AND status = 'approved' AND id <> $3`,
      [job.subject_kind, job.subject_name, id]);
    await client.query(`UPDATE effect_sprite_jobs SET status = 'approved', updated_at = now() WHERE id = $1`, [id]);
    await client.query('COMMIT');
    return { subject_kind: job.subject_kind, name: job.subject_name, columns };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* connection already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { enqueue, claimNext, nextPromptJob, promptWritten, promptFailed, markSeenRunning, setBoxJob, markDone, fail, requeue, latestBySubject, measuredSeconds, approve, randomSeed };
