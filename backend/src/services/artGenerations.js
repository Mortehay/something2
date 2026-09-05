// SOMET-547. The record of what was actually sent, and what came back.
//
// Read the migration header for why this is append-only and separate from both
// art_jobs and art_prompt_notes.
//
// THE ONE RULE THIS MODULE ENFORCES: recording history must NEVER fail a
// generation. An image that was produced, cut out and written to the catalogue
// has succeeded, and a bookkeeping error afterwards must not turn that into a
// failure and send the subject round the retry loop again. Every write here is
// therefore swallowed and logged, which is the opposite of the usual advice and
// is correct precisely because this table is an observation of the work rather
// than part of it.

// The generation parameters worth keeping, pulled off the request that was
// actually sent. Whitelisted rather than stored wholesale: the request carries
// the composed prompt (kept in its own column) and can carry provider
// credentials in nested override blocks, which must not be written to a table
// the admin UI reads back.
//
// KNOWN GAP, measured 2026-09-05: in practice this records only width and
// height. `steps`, `cfg_scale` and the sampler live in the PROVIDER's
// request_template and are merged in remoteImageProvider at send time, so the
// object handed to this module has never seen them. That makes the history
// honest about the subject and the size but INCOMPLETE for reproduction --
// a template edited between two runs is invisible here. Closing it means
// recording the final payload at the point it is serialised, which is a change
// to the provider path rather than to this module. Until then, do not present
// this column as a full reproduction recipe.
function paramsFrom(req) {
  if (!req || typeof req !== 'object') return {};
  const out = {};
  for (const k of ['width', 'height', 'steps', 'cfg_scale', 'sampler', 'cutout']) {
    if (req[k] !== undefined) out[k] = req[k];
  }
  return out;
}

async function record(db, {
  job, provider, req, outcome, error = null, imageKey = null,
}) {
  try {
    await db.query(
      `INSERT INTO art_generations
         (subject_kind, subject_key, art_job_id, composed_prompt, seed, model,
          provider_id, params, image_key, outcome, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        job.subject_kind,
        job.subject_key,
        job.id ?? null,
        (req && req.prompt) || null,
        job.seed ?? null,
        (provider && provider.model) || null,
        (provider && provider.id) || null,
        JSON.stringify(paramsFrom(req)),
        imageKey,
        outcome,
        // Capped: a provider can return a stack trace, and this column is read
        // back into a browser.
        error == null ? null : String(error).slice(0, 2000),
      ],
    );
  } catch (err) {
    // See the header. Never rethrow.
    console.error('art history: failed to record a generation', err && err.message);
  }
}

// One subject's history, newest first.
async function list(db, subjectKind, subjectKey, limit = 50) {
  const { rows } = await db.query(
    `SELECT id, art_job_id, composed_prompt, seed, model, provider_id, params,
            image_key, outcome, error, created_at
       FROM art_generations
      WHERE subject_kind = $1 AND subject_key = $2
      ORDER BY created_at DESC, id DESC
      LIMIT $3`,
    [subjectKind, subjectKey, Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200)],
  );
  return rows;
}

module.exports = { record, list, paramsFrom };
