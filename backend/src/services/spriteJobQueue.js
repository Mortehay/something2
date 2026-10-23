const { optionsForEntity, optionsForAppearance } = require('./spriteBatchOptions.js');
const { seedFor } = require('./artJobQueue.js');

// `targets` is a list of { entityId, variant } -- variant null/undefined
// means "the entity's own sprite", 1-5 means one of its character_appearances
// rows. One query loads plain entities, a second loads the requested
// (entity, variant) appearance rows; either can come back short, which is
// how `unknown` is built (an id or an id:variant pair nothing matched).
//
// `actions` / `framesPerAction` come from the admin's choice and apply to every
// target; without them a creature gets idle+walk and a prop idle (unused: a
// prop is not a sheet), at the frame count its options derive. Facings come from the options (8 or ['s']).
// Rows are written for the GPU box (backend 'gpu-box'); `frames` mirrors
// frames_per_action so older readers of `frames` still see the frame count.
// For a prop ('object') row the actions are not drawn (Props v2: one edited
// static image, no sheet); its in-game idle effect is `propFx` (none | sway |
// shine), stored as prop_fx on prop rows only and copied to
// entity_types.idle_fx on approve. Creature rows get NULL.
const DEFAULT_ACTIONS = { creature: ['idle', 'walk'], object: ['idle'] };
const PROP_FX = ['none', 'sway', 'shine'];

async function enqueue(db, targets, { actions, framesPerAction, propFx = 'none' } = {}) {
  if (!PROP_FX.includes(propFx)) throw new Error(`propFx must be one of ${PROP_FX.join(', ')}`);
  if (!Array.isArray(targets) || targets.length === 0) return { rows: [], updated: [], unknown: [] };
  const normalized = targets
    .map((t) => ({ entityId: Number(t.entityId), variant: t.variant == null ? null : Number(t.variant) }))
    .filter((t) => Number.isInteger(t.entityId) && (t.variant === null || (t.variant >= 1 && t.variant <= 5)));
  const key = (t) => `${t.entityId}:${t.variant ?? ''}`;
  const unique = [...new Map(normalized.map((t) => [key(t), t])).values()];

  const entityIds = [...new Set(unique.filter((t) => t.variant === null).map((t) => t.entityId))];
  const appearanceIds = [...new Set(unique.filter((t) => t.variant !== null).map((t) => t.entityId))];

  const [{ rows: entities }, { rows: appearances }] = await Promise.all([
    entityIds.length
      ? db.query(
        `SELECT id, name, prompt, render_mode, is_creature, is_playable
           FROM entity_types WHERE id = ANY($1::int[]) ORDER BY id`,
        [entityIds],
      )
      : { rows: [] },
    appearanceIds.length
      ? db.query(
        `SELECT ca.entity_type_id, ca.variant, e.name AS class_name, e.prompt AS class_prompt
           FROM character_appearances ca JOIN entity_types e ON e.id = ca.entity_type_id
          WHERE ca.entity_type_id = ANY($1::int[]) ORDER BY ca.entity_type_id, ca.variant`,
        [appearanceIds],
      )
      : { rows: [] },
  ]);

  const requestedAppearances = new Set(
    unique.filter((t) => t.variant !== null).map((t) => `${t.entityId}:${t.variant}`),
  );
  // The query above loads every variant of each requested class (one round
  // trip instead of N); narrow back to only the (entity, variant) pairs the
  // caller actually asked for.
  const matchedAppearances = appearances.filter((a) => requestedAppearances.has(`${a.entity_type_id}:${a.variant}`));

  const foundEntities = new Set(entities.map((e) => e.id));
  const foundAppearances = new Set(matchedAppearances.map((a) => `${a.entity_type_id}:${a.variant}`));
  const unknown = unique
    .filter((t) => (t.variant === null ? !foundEntities.has(t.entityId) : !foundAppearances.has(`${t.entityId}:${t.variant}`)))
    .map((t) => (t.variant === null ? t.entityId : `${t.entityId}:${t.variant}`));

  const opts = [...entities.map((e) => optionsForEntity(e)), ...matchedAppearances.map((a) => optionsForAppearance(a))];
  if (opts.length === 0) return { rows: [], updated: [], unknown };

  const { rows: prior } = await db.query(
    `SELECT creature, count(*)::int AS n FROM sprite_sets
      WHERE creature = ANY($1::text[]) GROUP BY creature`,
    [opts.map((o) => o.subject)],
  );
  const counts = new Map(prior.map((r) => [r.creature, r.n]));
  const chosenActions = Array.isArray(actions) && actions.length ? actions : null;
  const rowFrames = (o) => (Number.isInteger(framesPerAction) ? framesPerAction : o.frames);
  const rowActions = (o) => (chosenActions || DEFAULT_ACTIONS[o.kind] || DEFAULT_ACTIONS.creature).join(',');
  const rowPropFx = (o) => (o.kind === 'object' ? propFx : null);
  // A target that already has a QUEUED job gets this call's actions, frames and
  // prop effect instead of a second row (the live-job index forbids one), so a
  // mistaken queue is fixed in place. `status = 'queued'` is re-checked after
  // claim()'s row lock, so a job the dispatcher just took is left alone; the
  // INSERT below then conflicts on it and it counts as skipped.
  // A rescued row keeps its box job so the batch resumes it -- but that job
  // draws the OLD actions/frames, so a change detaches it (the next claim
  // submits afresh) and `dropped_box_job_id` names it for the caller to cancel.
  // A queued REDRAW row of a target is deleted first: a full "Queue" supersedes
  // it with a fresh full-sheet row (below), never a hybrid of the two.
  await db.query(
    `DELETE FROM sprite_sets s
      USING unnest($1::int[], $2::smallint[]) AS t(entity_id, variant)
      WHERE s.redraw_of IS NOT NULL AND s.status = 'queued'
        AND s.entity_type_id = t.entity_id
        AND COALESCE(s.appearance_variant, 0) = COALESCE(t.variant, 0)`,
    [opts.map((o) => o.entityTypeId), opts.map((o) => o.appearanceVariant)],
  );
  const { rows: updated } = await db.query(
    `UPDATE sprite_sets s
        SET actions = string_to_array(t.actions, ','), frames = t.frames, frames_per_action = t.frames,
            prop_fx = t.prop_fx, updated_at = now(),
            box_job_id = CASE WHEN s.actions IS DISTINCT FROM string_to_array(t.actions, ',')
                                OR s.frames_per_action IS DISTINCT FROM t.frames
                              THEN NULL ELSE s.box_job_id END
       FROM unnest($1::int[], $2::smallint[], $3::int[], $4::text[], $5::text[])
         AS t(entity_id, variant, frames, actions, prop_fx),
            sprite_sets o
      WHERE s.entity_type_id = t.entity_id
        AND COALESCE(s.appearance_variant, 0) = COALESCE(t.variant, 0)
        AND s.status = 'queued' AND s.redraw_of IS NULL AND o.id = s.id
      RETURNING s.*, CASE WHEN s.box_job_id IS NULL THEN o.box_job_id END AS dropped_box_job_id`,
    [
      opts.map((o) => o.entityTypeId), opts.map((o) => o.appearanceVariant),
      opts.map(rowFrames), opts.map(rowActions), opts.map(rowPropFx),
    ],
  );
  const { rows } = await db.query(
    `INSERT INTO sprite_sets
       (entity_type_id, appearance_variant, creature, generation_kind, base_prompt, backend, seed, frames, status,
        actions, directions, frames_per_action, prop_fx)
     SELECT entity_id, variant, subject, kind, prompt, 'gpu-box', seed, frames, 'queued',
            string_to_array(actions, ','), string_to_array(directions, ','), frames, prop_fx
       FROM unnest($1::int[], $2::smallint[], $3::text[], $4::text[], $5::text[], $6::int[], $7::int[],
                   $8::text[], $9::text[], $10::text[])
         AS t(entity_id, variant, subject, kind, prompt, seed, frames, actions, directions, prop_fx)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [
      opts.map((o) => o.entityTypeId), opts.map((o) => o.appearanceVariant),
      opts.map((o) => o.subject), opts.map((o) => o.kind), opts.map((o) => o.prompt),
      opts.map((o) => seedFor('sprite', o.subject, counts.get(o.subject) || 0)),
      opts.map(rowFrames),
      opts.map(rowActions),
      opts.map((o) => o.directions.join(',')),
      opts.map(rowPropFx),
    ],
  );
  return { rows, updated, unknown };
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

// Cells still waiting to be claimed (same filter as claim): a prop is 1, a
// creature sheet is actions x directions x frames.
async function queuedCells(db) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(CASE WHEN redraw_of IS NOT NULL THEN jsonb_array_length(redraw_frames)
              WHEN generation_kind = 'object' THEN 1
              ELSE cardinality(actions) * cardinality(directions) * frames_per_action END), 0)::int AS cells
       FROM sprite_sets WHERE status = 'queued' AND entity_type_id IS NOT NULL`,
  );
  return rows[0] ? rows[0].cells : 0;
}

async function attach(db, id, { jobId, backend, frames }) {
  const { rows } = await db.query(
    `UPDATE sprite_sets SET job_id = $2, backend = $3, frames = $4, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, jobId, backend, frames],
  );
  return rows[0] || null;
}

// Records the box job (and the concept image it was drawn from) the moment the
// box accepts it, so a restart can resume polling instead of resubmitting.
// job_id mirrors box_job_id: the existing queue view and stop paths read job_id.
async function attachBox(db, id, { boxJobId, conceptKey, providerId }) {
  const { rows } = await db.query(
    `UPDATE sprite_sets SET box_job_id = $2, job_id = $2, concept_key = $3, provider_id = $4,
            backend = 'gpu-box', updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, boxJobId, conceptKey || null, providerId ?? null],
  );
  return rows[0] || null;
}

async function complete(db, id, result) {
  const { rows } = await db.query(
    `UPDATE sprite_sets SET status = 'done', image_key = $2, atlas_key = $3,
            manifest_key = $4, concept_key = COALESCE($5, concept_key), sheet_seconds = COALESCE($6, sheet_seconds), finished_at = now(),
            last_error = NULL, claimed_at = NULL, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, result.image_key || null, result.atlas_key || null, result.manifest_key || null,
      result.concept_key || null,
      Number.isFinite(result.sheet_seconds) ? Math.round(result.sheet_seconds) : null],
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

// A row the admin halted mid-run goes back to the queue to be drawn afresh:
// its box job was cancelled, so it is detached rather than resumed.
// A redraw row keeps its sheet's box_job_id; its redraw task is dropped unless
// `keepTask` (the cancel failed, so the task may still run and the next run
// resumes polling it instead of submitting a second one).
async function requeueHalted(db, id, { keepTask = false } = {}) {
  const { rows } = await db.query(
    `UPDATE sprite_sets SET status = 'queued', claimed_at = NULL,
            box_job_id = CASE WHEN redraw_of IS NOT NULL THEN box_job_id END,
            box_task_id = CASE WHEN $2::boolean THEN box_task_id END,
            last_error = 'halted from the Sprite Generation page', updated_at = now()
      WHERE id = $1 AND status = 'running' RETURNING *`,
    [id, keepTask],
  );
  return rows[0] || null;
}

// Redraw rows: a copy of a finished sheet row plus the frames to redraw. The
// copy keeps box_job_id/concept_key so the box redraws inside the same job.
// The live-job unique index rejects it (-> null) while the subject has a
// queued/running row. sheet_seconds stays NULL: a redraw has no sheet timing.
async function createRedraw(db, source, frames) {
  const { rows } = await db.query(
    `INSERT INTO sprite_sets
       (entity_type_id, appearance_variant, creature, generation_kind, base_prompt, backend, seed, frames,
        actions, directions, frames_per_action, concept_key, box_job_id, provider_id,
        status, redraw_of, redraw_frames)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'queued', $15, $16::jsonb)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [source.entity_type_id, source.appearance_variant, source.creature, source.generation_kind,
      source.base_prompt, source.backend, source.seed, source.frames,
      source.actions, source.directions, source.frames_per_action, source.concept_key,
      source.box_job_id, source.provider_id, source.id, JSON.stringify(frames)],
  );
  return rows[0] || null;
}

async function attachRedrawTask(db, id, taskId) {
  const { rows } = await db.query(
    'UPDATE sprite_sets SET box_task_id = $2, updated_at = now() WHERE id = $1 RETURNING *',
    [id, taskId],
  );
  return rows[0] || null;
}

// Sheet keys only, no status change: a failed redraw may still have changed
// the box's sheet, and this keeps a way to view it.
async function recordRedrawSheet(db, id, { atlas_key, manifest_key }) {
  const { rows } = await db.query(
    'UPDATE sprite_sets SET atlas_key = $2, manifest_key = $3, updated_at = now() WHERE id = $1 RETURNING *',
    [id, atlas_key || null, manifest_key || null],
  );
  return rows[0] || null;
}

// Deletes a redraw that never changed the box's sheet: still queued, or failed
// before a task / sheet existed. Anything else (done, or failed with a sheet)
// stays, as the box sheet may already carry its frames.
async function discardRedraw(db, id) {
  const { rows } = await db.query(
    `DELETE FROM sprite_sets
      WHERE id = $1 AND redraw_of IS NOT NULL
        AND (status = 'queued'
             OR (status = 'failed' AND (box_task_id IS NULL OR atlas_key IS NULL)))
      RETURNING id`,
    [id],
  );
  if (rows[0]) return 'deleted';
  const { rows: found } = await db.query('SELECT 1 FROM sprite_sets WHERE id = $1 AND redraw_of IS NOT NULL', [id]);
  return found[0] ? 'not_discardable' : 'not_found';
}

// "Delete generated": removes every sprite_sets row of each target subject
// (any status, redraw chains included) and un-publishes the sprite a creature
// subject had approved. Runs inside the CALLER's transaction. A subject with a
// running row is skipped whole. Props keep their entity row (their image is
// the entity's own art, not a sheet). `cancel_box_job_ids` are the box jobs of
// deleted queued rows, for the caller to cancel after commit.
async function deleteGeneratedRows(client, targets) {
  const seen = new Map();
  for (const t of targets || []) {
    const variant = t.variant == null ? null : Number(t.variant);
    seen.set(`${t.entityId}:${variant ?? ''}`, { entityId: Number(t.entityId), variant });
  }
  const rows = [];
  const skipped_running = [];
  const cancel = [];
  let subjects = 0;
  for (const { entityId, variant } of seen.values()) {
    const where = 'entity_type_id = $1 AND COALESCE(appearance_variant, 0) = COALESCE($2::smallint, 0)';
    // Lock the subject's rows first: a dispatcher claim() waits (or skips them)
    // until this transaction ends, so the running check below cannot go stale
    // before the DELETE.
    await client.query(`SELECT id FROM sprite_sets WHERE ${where} FOR UPDATE`, [entityId, variant]);
    const { rows: running } = await client.query(
      `SELECT 1 FROM sprite_sets WHERE ${where} AND status = 'running' LIMIT 1`, [entityId, variant],
    );
    if (running[0]) {
      skipped_running.push(variant == null ? String(entityId) : `${entityId}:${variant}`);
      continue;
    }
    // One statement removes parents and children together; redraw_of's
    // ON DELETE SET NULL has nothing left to null.
    const { rows: deleted } = await client.query(
      `DELETE FROM sprite_sets WHERE ${where} RETURNING *`, [entityId, variant],
    );
    if (deleted.length === 0) continue;
    subjects += 1;
    rows.push(...deleted);
    for (const r of deleted) if (r.status === 'queued' && r.box_job_id) cancel.push(r.box_job_id);
    const isProp = deleted.some((r) => r.generation_kind === 'object')
      && !deleted.some((r) => r.generation_kind === 'creature');
    if (isProp) continue;
    if (variant == null) {
      await client.query(
        `UPDATE entity_types SET sprite = NULL, render_mode = 'static' WHERE id = $1`, [entityId],
      );
    } else {
      await client.query(
        `UPDATE character_appearances SET sprite = NULL, render_mode = 'static', updated_at = now()
          WHERE entity_type_id = $1 AND variant = $2`, [entityId, variant],
      );
    }
  }
  return { rows, subjects, skipped_running, cancel_box_job_ids: cancel };
}

async function setNote(db, id, note) {
  const { rows } = await db.query(
    'UPDATE sprite_sets SET note = $2, updated_at = now() WHERE id = $1 RETURNING *', [id, note ?? null],
  );
  return rows[0] || null;
}

// Measured wall seconds per sheet cell (action x facing x frame) of the most
// recently COMPLETED sheet that recorded a positive time (finished_at, which
// approve does not bump); null when none has. The route applies
// the seed default, so "no data yet" stays distinguishable here.
async function lastSecondsPerCell(db) {
  const { rows } = await db.query(
    `SELECT sheet_seconds::float8 / (cardinality(actions) * cardinality(directions) * frames_per_action) AS spc
       FROM sprite_sets
      WHERE status IN ('done','approved') AND sheet_seconds > 0
        AND cardinality(actions) > 0 AND cardinality(directions) > 0 AND frames_per_action > 0
      ORDER BY finished_at DESC NULLS LAST, id DESC LIMIT 1`,
  );
  return rows[0] ? rows[0].spc : null;
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
      `SELECT s.id, s.entity_type_id, s.appearance_variant, s.creature, s.generation_kind, s.frames,
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

module.exports = { enqueue, claim, attach, attachBox, complete, fail, requeueStale, requeueHalted, createRedraw, attachRedrawTask, recordRedrawSheet, discardRedraw, deleteGeneratedRows, setNote, lastSecondsPerCell, queuedCells, stats, queueView, PROP_FX };
