const { optionsForEntity } = require('./spriteBatchOptions.js');
const { seedFor } = require('./artJobQueue.js');

async function enqueue(db, entityIds) {
  if (!Array.isArray(entityIds) || entityIds.length === 0) return { rows: [], unknown: [] };
  const ids = [...new Set(entityIds.filter(Number.isInteger))];
  const { rows: entities } = await db.query(
    `SELECT id, name, prompt, render_mode, is_creature, is_playable
       FROM entity_types WHERE id = ANY($1::int[]) ORDER BY id`,
    [ids],
  );
  const found = new Set(entities.map((e) => e.id));
  const unknown = ids.filter((id) => !found.has(id));
  if (entities.length === 0) return { rows: [], unknown };

  const opts = entities.map((e) => optionsForEntity(e));
  const { rows: prior } = await db.query(
    `SELECT creature, count(*)::int AS n FROM sprite_sets
      WHERE creature = ANY($1::text[]) GROUP BY creature`,
    [opts.map((o) => o.subject)],
  );
  const counts = new Map(prior.map((r) => [r.creature, r.n]));
  const { rows } = await db.query(
    `INSERT INTO sprite_sets
       (entity_type_id, creature, generation_kind, base_prompt, backend, seed, frames, status)
     SELECT entity_id, subject, kind, prompt, 'auto', seed, frames, 'queued'
       FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::int[], $6::int[])
         AS t(entity_id, subject, kind, prompt, seed, frames)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [
      opts.map((o) => o.entityTypeId), opts.map((o) => o.subject), opts.map((o) => o.kind),
      opts.map((o) => o.prompt),
      opts.map((o) => seedFor('sprite', o.subject, counts.get(o.subject) || 0)),
      opts.map((o) => o.frames),
    ],
  );
  return { rows, unknown };
}

async function claim(db) {
  const { rows } = await db.query(
    `UPDATE sprite_sets SET status = 'running', attempts = attempts + 1,
            claimed_at = now(), updated_at = now()
      WHERE id = (
        SELECT id FROM sprite_sets
         WHERE status = 'queued' AND entity_type_id IS NOT NULL
         ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`,
  );
  return rows[0] || null;
}

async function attach(db, id, { jobId, backend, frames }) {
  const { rows } = await db.query(
    `UPDATE sprite_sets SET job_id = $2, backend = $3, frames = $4, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, jobId, backend, frames],
  );
  return rows[0] || null;
}

async function complete(db, id, result) {
  const { rows } = await db.query(
    `UPDATE sprite_sets SET status = 'done', image_key = $2, atlas_key = $3,
            manifest_key = $4, last_error = NULL, claimed_at = NULL, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, result.image_key || null, result.atlas_key || null, result.manifest_key || null],
  );
  return rows[0] || null;
}

async function fail(db, id, error) {
  const message = String(error && error.message ? error.message : error).slice(0, 2000);
  const { rows } = await db.query(
    `UPDATE sprite_sets SET status = 'failed', last_error = $2,
            claimed_at = NULL, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, message],
  );
  return rows[0] || null;
}

async function requeueStale(db, staleMs = 60000) {
  const { rows } = await db.query(
    `UPDATE sprite_sets SET status = 'queued', claimed_at = NULL,
            last_error = COALESCE(last_error, 'worker stopped before the job completed'),
            updated_at = now()
      WHERE status = 'running'
        AND claimed_at < now() - make_interval(secs => $1::double precision)
      RETURNING *`,
    [staleMs / 1000],
  );
  return rows;
}

async function stats(db) {
  const { rows } = await db.query(
    `SELECT status, count(*)::int AS n FROM sprite_sets
      WHERE entity_type_id IS NOT NULL GROUP BY status`,
  );
  return rows.reduce((out, row) => ({ ...out, [row.status]: row.n }), {});
}

async function queueView(db) {
  const [counts, active] = await Promise.all([
    stats(db),
    db.query(
      `SELECT s.id, s.entity_type_id, s.creature, s.generation_kind, s.frames,
              s.backend, s.status, s.attempts, s.last_error, s.claimed_at,
              s.created_at, s.updated_at, s.job_id, s.image_key, s.atlas_key,
              s.manifest_key
         FROM sprite_sets s
        WHERE s.entity_type_id IS NOT NULL
          AND s.status IN ('queued','running','done','failed')
        ORDER BY CASE s.status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
                 s.created_at DESC LIMIT 100`,
    ),
  ]);
  return { stats: counts, jobs: active.rows };
}

module.exports = { enqueue, claim, attach, complete, fail, requeueStale, stats, queueView };
