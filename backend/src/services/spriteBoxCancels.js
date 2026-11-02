// Records, verifies and retries the cancels sent to the GPU box (SOMET-695).
// The box's DELETE /api/jobs/{id} can mark a sheet job cancelled while its
// worker keeps drawing, so every cancel is a row here until the box's own
// progress stops moving. All times are OUR clock; box timestamps are only
// compared to each other, never to ours.
const defaultBox = require('./gpuBoxSprites.js');

const settleMs = () => Number(process.env.SPRITE_CANCEL_SETTLE_MS) || 180000;
const graceMs = () => Number(process.env.SPRITE_CANCEL_GRACE_MS) || 60000;
const maxAgeMs = () => Number(process.env.SPRITE_CANCEL_MAX_AGE_MS) || 6 * 3600000;

const COLS = `id, box_job_id, sprite_set_id, subject, source, state, requested_at,
              last_progress, last_box_updated_at, last_change_at, checked_at, stopped_at`;

// Sends the cancel and records it. The row is written even when the DELETE
// fails (the error goes in last_progress) so the admin sees it and can retry.
// A failed write is logged and never replaces the box's answer.
// source: halt|clear|delete-generated|options-changed|turnaround|redraw|retry|abandoned.
async function request(db, provider, { boxJobId, spriteSetId = null, subject = null, source }, { box = defaultBox, now = Date.now } = {}) {
  let result;
  try {
    result = await box.cancelSheetJob(provider, boxJobId);
  } catch (err) {
    result = { ok: false, error: err.message };
  }
  const ok = Boolean(result && result.ok);
  const error = ok ? null : String((result && result.error) || 'cancel failed');
  try {
    await db.query(
      `INSERT INTO sprite_box_cancels (box_job_id, sprite_set_id, subject, source, state, requested_at, last_progress)
       VALUES ($1, $2, $3, $4, 'stopping', to_timestamp($5::double precision / 1000), $6)
       ON CONFLICT (box_job_id) WHERE state <> 'stopped' DO UPDATE
          SET requested_at = EXCLUDED.requested_at, state = 'stopping', source = EXCLUDED.source,
              sprite_set_id = COALESCE(EXCLUDED.sprite_set_id, sprite_box_cancels.sprite_set_id),
              subject = COALESCE(EXCLUDED.subject, sprite_box_cancels.subject),
              last_progress = EXCLUDED.last_progress, last_box_updated_at = NULL,
              last_change_at = NULL, checked_at = NULL`,
      [boxJobId, spriteSetId, subject, source, now(), error],
    );
  } catch (err) {
    console.error(`sprite: could not record box cancel for ${boxJobId}: ${err.message}`);
  }
  return ok ? { ok: true } : { ok: false, error };
}

async function open(db) {
  const { rows } = await db.query(
    `SELECT ${COLS} FROM sprite_box_cancels WHERE state <> 'stopped' ORDER BY requested_at DESC, id DESC`,
  );
  return rows;
}

async function verify(db, provider, {
  box = defaultBox, now = Date.now, settleMs: settle = settleMs(), graceMs: grace = graceMs(), maxAgeMs: maxAge = maxAgeMs(),
} = {}) {
  const rows = await open(db);
  for (const row of rows) {
    const requestedAt = new Date(row.requested_at).getTime();
    // Every write is guarded by the requested_at we read: a request() or retry
    // that reset the row while the box call was in flight must not be overwritten.
    const guard = (sql, params) => db.query(`${sql} AND requested_at = $${params.length + 1}`, [...params, row.requested_at]);
    if (now() - requestedAt > maxAge) {
      // eslint-disable-next-line no-await-in-loop
      await guard(
        `UPDATE sprite_box_cancels SET state = 'stopped', stopped_at = to_timestamp($2::double precision / 1000),
                last_progress = 'gave up verifying after 6 h' WHERE id = $1`,
        [row.id, now()],
      );
      continue;
    }
    let r;
    try {
      // eslint-disable-next-line no-await-in-loop
      r = await box.getSheetJob(provider, row.box_job_id);
    } catch (err) {
      r = { ok: false, error: err.message };
    }
    // An unknown status is still the box talking: its raw status and message
    // are the progress signal. Any other failure proves nothing.
    if (r && !r.ok && r.rawStatus !== undefined) {
      r = { ok: true, job: { status: r.rawStatus, progress: { ...(r.progress || {}), message: r.progress && r.progress.message ? r.progress.message : r.rawStatus }, updatedAt: r.updatedAt } };
    }
    if (!r || !r.ok) continue;
    const t = now();
    if (r.job.status === 'missing') {
      // eslint-disable-next-line no-await-in-loop
      await guard(
        `UPDATE sprite_box_cancels SET state = 'stopped', stopped_at = to_timestamp($2::double precision / 1000),
                checked_at = to_timestamp($2::double precision / 1000) WHERE id = $1`,
        [row.id, t],
      );
      continue;
    }
    const { progress = {}, updatedAt = null } = r.job;
    const sig = updatedAt || progress.message || null;
    const text = progress.message || updatedAt || null;
    const prev = row.last_box_updated_at;
    if (prev !== null && sig !== null && sig !== prev) {
      // Progress moved. A cooperative box finishes the cell it was on (once)
      // and stops, so one change is not proof. Only a change seen after a
      // check that was itself past the grace window shows the box kept going.
      const prevChecked = row.checked_at ? new Date(row.checked_at).getTime() : null;
      const state = prevChecked !== null && prevChecked - requestedAt > grace ? 'still_drawing' : row.state;
      // eslint-disable-next-line no-await-in-loop
      await guard(
        `UPDATE sprite_box_cancels SET state = $2, last_box_updated_at = $3, last_progress = $4,
                last_change_at = to_timestamp($5::double precision / 1000),
                checked_at = to_timestamp($5::double precision / 1000) WHERE id = $1`,
        [row.id, state, sig, text, t],
      );
      continue;
    }
    // First sight of this job since the cancel: record the baseline only. A
    // job nobody looked at for a while may still be drawing, so settling needs
    // an observed unchanged span after this point.
    if (!row.last_change_at) {
      // eslint-disable-next-line no-await-in-loop
      await guard(
        `UPDATE sprite_box_cancels SET last_box_updated_at = $2, last_progress = COALESCE($3, last_progress),
                last_change_at = to_timestamp($4::double precision / 1000),
                checked_at = to_timestamp($4::double precision / 1000) WHERE id = $1`,
        [row.id, sig, text, t],
      );
      continue;
    }
    // Unchanged: settled once it has not moved for the settle window, counted
    // from the last change we saw.
    const since = new Date(row.last_change_at).getTime();
    const settled = t - since >= settle;
    // eslint-disable-next-line no-await-in-loop
    await guard(
      `UPDATE sprite_box_cancels SET state = $2, last_box_updated_at = COALESCE($3, last_box_updated_at),
              last_progress = COALESCE($4, last_progress),
              checked_at = to_timestamp($5::double precision / 1000),
              stopped_at = CASE WHEN $2 = 'stopped' THEN to_timestamp($5::double precision / 1000) ELSE stopped_at END
        WHERE id = $1`,
      [row.id, settled ? 'stopped' : row.state, sig, text, t],
    );
  }
  return open(db);
}

// Open row by id, or null (unknown or already stopped).
async function getOpen(db, id) {
  const { rows } = await db.query(`SELECT ${COLS} FROM sprite_box_cancels WHERE id = $1 AND state <> 'stopped'`, [id]);
  return rows[0] || null;
}

// What GET /jobs shows.
const view = (row) => ({
  id: row.id, box_job_id: row.box_job_id, subject: row.subject, source: row.source,
  state: row.state, requested_at: row.requested_at, last_progress: row.last_progress,
});

module.exports = { request, verify, open, getOpen, view };
