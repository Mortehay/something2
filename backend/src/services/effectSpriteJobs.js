// The effect_sprite_jobs queue (generated effect strips). One active job per subject is held
// by the partial unique index; every function takes a pg Pool/Client as `db`.
'use strict';
const crypto = require('node:crypto');
const { subjectOf, readAtlas, approveColumns, effectEstimate } = require('./effectSprites.js');

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

async function enqueue(db, targets, { seed = randomSeed } = {}) {
  const queued = [];
  const skipped = [];
  for (const t of targets) {
    const s = subjectOf(t.subject_kind, t.name);
    if (!s) { skipped.push({ subject_kind: t.subject_kind, name: t.name, reason: 'unknown subject' }); continue; }
    const predicted = Math.max(1, Math.round(effectEstimate(s.kind, await measuredSeconds(db, s.kind)).typical));
    try {
      const { rows } = await db.query(
        `INSERT INTO effect_sprite_jobs
           (subject_kind, subject_name, prompt, kind, frames, size, loop, blend, seed, predicted_seconds)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [s.subject_kind, s.name, t.prompt, s.kind, s.frames, s.size, s.loop, s.blend,
          typeof seed === 'function' ? seed() : seed, predicted],
      );
      queued.push(rows[0]);
    } catch (err) {
      if (err && err.code === '23505') skipped.push({ subject_kind: s.subject_kind, name: s.name, reason: 'already queued' });
      else throw err;
    }
  }
  return { queued, skipped };
}

async function claimNext(db) {
  const { rows } = await db.query(
    `UPDATE effect_sprite_jobs SET status = 'running', running_since = NULL, updated_at = now()
      WHERE id = (SELECT id FROM effect_sprite_jobs WHERE status = 'queued'
                   ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`,
  );
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

module.exports = { enqueue, claimNext, markSeenRunning, setBoxJob, markDone, fail, requeue, latestBySubject, measuredSeconds, approve, randomSeed };
