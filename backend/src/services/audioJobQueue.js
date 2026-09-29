// backend/src/services/audioJobQueue.js
//
// The audio generation queue (spec §2 "Dispatcher"). Modelled on
// artJobQueue.js; the differences are deliberate:
//   * claimed in DRAIN_ORDER groups (music, ambience, then sfx split by
//     engine) so the GPU box switches model at most once per group; music
//     and ambience are claimed one job at a time, sfx in batches of up to n
//     (claimBatch) because the dispatcher sends them as one sfx-pack call;
//   * requeueOrphans runs at every drain start: a nodemon restart (ANY backend
//     edit) kills a running drain mid-job, and art's manual "requeue stale"
//     button is exactly the step people forget.
const DRAIN_ORDER = ['music', 'ambience', 'sfx_realistic', 'sfx_retro'];
// Groups whose jobs are claimed together and sent as ONE box request.
const PACKED_GROUPS = ['sfx_realistic', 'sfx_retro'];
const SFX_ENGINES = ['realistic', 'retro'];
const MAX_ATTEMPTS = Number(process.env.AUDIO_JOB_MAX_ATTEMPTS) || 3;
// Validated like audioDispatcher's envInt (finite and > 0, else the
// default): a stray negative or zero value here doesn't just miscompute a
// backoff, it would make backoffMs(1) negative or zero, and the dispatcher's
// busy-response pause (audioDispatcher.js, `sleepSliced(deps.queue.backoffMs(1), ...)`)
// would then sleep for ~0ms instead of actually pausing before the next claim.
const RETRY_BASE_MS = () => {
  const v = Number(process.env.AUDIO_JOB_RETRY_BASE_MS);
  return Number.isFinite(v) && v > 0 ? v : 30000;
};

// The box keeps one model loaded per engine, so realistic and retro sfx are
// separate groups. An absent engine means realistic (spec §4 "The engine
// defaults to realistic, and a batch can choose retro").
function drainGroupFor(clipKind, engine = 'realistic') {
  if (clipKind === 'music' || clipKind === 'ambience') return clipKind;
  if (clipKind === 'sfx') return engine === 'retro' ? 'sfx_retro' : 'sfx_realistic';
  throw new Error(`no drain group for ${clipKind}`);
}

// The engine stored on an sfx row (null for music/ambience). Stored rather
// than re-derived from drain_group so the dispatcher sends exactly what was
// queued.
function engineFor(clipKind, engine) {
  if (clipKind !== 'sfx') return null;
  return SFX_ENGINES.includes(engine) ? engine : 'realistic';
}

function backoffMs(attempts) {
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.round(RETRY_BASE_MS() * 2 ** Math.max(0, attempts - 1) * jitter);
}

async function enqueue(db, items, { batchId = null, providerId = null } = {}) {
  const batch = batchId || (await db.query('SELECT gen_random_uuid() AS id')).rows[0].id;
  const cols = {
    kind: [], key: [], slot: [], clip: [], group: [], style: [], prompt: [], slots: [], seed: [], engine: [],
  };
  for (const it of items) {
    cols.kind.push(it.subject_kind); cols.key.push(it.subject_key); cols.slot.push(it.slot);
    const engine = engineFor(it.clip_kind, it.engine);
    cols.clip.push(it.clip_kind); cols.group.push(drainGroupFor(it.clip_kind, engine || undefined));
    cols.engine.push(engine);
    cols.style.push(it.style || null); cols.prompt.push(it.prompt || null);
    cols.slots.push(it.slots ? JSON.stringify(it.slots) : null);
    cols.seed.push(Number.isInteger(it.seed) ? it.seed : null);
  }
  const r = await db.query(
    `INSERT INTO audio_jobs (batch_id, provider_id, subject_kind, subject_key, slot, clip_kind, drain_group,
                             style, prompt, slots, seed, engine)
     SELECT $1, $2, k, key, s, c, g, st, pr, sl::jsonb, sd, en
       FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::bigint[],
                   $12::text[])
         AS u(k, key, s, c, g, st, pr, sl, sd, en)
     ON CONFLICT DO NOTHING RETURNING *`,
    [batch, providerId, cols.kind, cols.key, cols.slot, cols.clip, cols.group, cols.style, cols.prompt, cols.slots, cols.seed,
      cols.engine],
  );
  const got = new Set(r.rows.map((j) => `${j.subject_kind}/${j.subject_key}/${j.slot}`));
  const already_live = items
    .filter((it) => !got.has(`${it.subject_kind}/${it.subject_key}/${it.slot}`))
    .map(({ subject_kind, subject_key, slot }) => ({ subject_kind, subject_key, slot }));
  return { batch_id: batch, queued: r.rows, already_live };
}

async function claimNext(db) {
  const r = await db.query(
    `UPDATE audio_jobs SET state = 'running', attempts = attempts + 1, claimed_at = now(), updated_at = now()
      WHERE id = (
        SELECT id FROM audio_jobs
         WHERE state = 'queued' AND (not_before IS NULL OR not_before <= now())
         ORDER BY array_position($1::text[], drain_group), id
         FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`,
    [DRAIN_ORDER],
  );
  return r.rows[0] || null;
}

// Claims up to `n` jobs of ONE drain group: the group (and provider pin) of
// the first claimable job in DRAIN_ORDER. Only a PACKED group (sfx) takes
// more than one -- music/ambience are one box call per job, so they stay one
// job per claim whatever `n` is. Same provider_id only, because a batch is
// one request to one box. Returned in id order.
//
// `first` takes its row FOR UPDATE SKIP LOCKED too, so a concurrent claimer
// cannot pick the same head row; `pick` re-locks it in this same statement
// (a transaction never blocks on its own lock).
async function claimBatch(db, n) {
  const limit = Number.isInteger(n) && n > 0 ? n : 1;
  const r = await db.query(
    `WITH first AS (
       SELECT drain_group, provider_id FROM audio_jobs
        WHERE state = 'queued' AND (not_before IS NULL OR not_before <= now())
        ORDER BY array_position($1::text[], drain_group), id
        FOR UPDATE SKIP LOCKED LIMIT 1
     ), pick AS (
       SELECT j.id FROM audio_jobs j, first f
        WHERE j.state = 'queued' AND (j.not_before IS NULL OR j.not_before <= now())
          AND j.drain_group = f.drain_group AND j.provider_id IS NOT DISTINCT FROM f.provider_id
        ORDER BY j.id
        LIMIT CASE WHEN (SELECT drain_group FROM first) = ANY($3::text[]) THEN $2::int ELSE 1 END
        FOR UPDATE OF j SKIP LOCKED
     )
     UPDATE audio_jobs SET state = 'running', attempts = attempts + 1, claimed_at = now(), updated_at = now()
      WHERE id IN (SELECT id FROM pick)
      RETURNING *`,
    [DRAIN_ORDER, limit, PACKED_GROUPS],
  );
  return r.rows.sort((a, b) => Number(a.id) - Number(b.id));
}

// Claimed jobs straight back to 'queued', attempt refunded, NO backoff. For
// jobs that were never actually tried -- e.g. the rest of an sfx pack that
// one unknown cue made the box refuse as a whole. fail(..., {refundAttempt})
// is the busy-box variant: that one DOES back off, because the box said
// "not now".
async function release(db, ids) {
  if (!ids.length) return 0;
  return (await db.query(
    `UPDATE audio_jobs SET state = 'queued', attempts = GREATEST(attempts - 1, 0), claimed_at = NULL,
            not_before = NULL, updated_at = now()
      WHERE id = ANY($1::bigint[]) AND state = 'running'`,
    [ids],
  )).rowCount;
}

async function complete(db, id, clipId) {
  await db.query(
    `UPDATE audio_jobs SET state = 'done', clip_id = $2, last_error = NULL, updated_at = now() WHERE id = $1`,
    [id, clipId],
  );
}

// `refundAttempt` is for a BUSY box (HTTP 409/503, spec §2): "not now" is not
// a strike against the job, so the attempt the claim just spent on it is
// given back (GREATEST(attempts-1,0), same refund requeueOrphans already
// does for an orphaned row) and it is always requeued -- MAX_ATTEMPTS is a
// budget for THIS job being bad, and a busy answer says nothing about that.
async function fail(db, id, error, { retryable = false, refundAttempt = false } = {}) {
  const row = (await db.query('SELECT attempts FROM audio_jobs WHERE id = $1', [id])).rows[0];
  if (!row) return 'failed';
  const attempts = refundAttempt ? Math.max(row.attempts - 1, 0) : row.attempts;
  const retry = retryable && (refundAttempt || attempts < MAX_ATTEMPTS);
  await db.query(
    `UPDATE audio_jobs SET state = $2, last_error = $3, updated_at = now(), attempts = $5,
            not_before = CASE WHEN $2 = 'queued' THEN now() + ($4::int * interval '1 millisecond') ELSE NULL END
      WHERE id = $1`,
    [id, retry ? 'queued' : 'failed', String(error).slice(0, 2000), retry ? backoffMs(attempts) : 0, attempts],
  );
  return retry ? 'retry' : 'failed';
}

async function requeueOrphans(db) {
  const r = await db.query(
    `UPDATE audio_jobs SET state = 'queued', attempts = GREATEST(attempts - 1, 0), claimed_at = NULL, updated_at = now()
      WHERE state = 'running'`,
  );
  return r.rowCount;
}

async function nextClaimableAt(db) {
  const r = await db.query(
    `SELECT min(COALESCE(not_before, now())) AS at FROM audio_jobs WHERE state = 'queued'`,
  );
  return r.rows[0].at;
}

async function stats(db) {
  const r = await db.query(
    `SELECT drain_group, state, count(*)::int AS n,
            count(*) FILTER (WHERE state = 'queued' AND not_before > now())::int AS backoff
       FROM audio_jobs GROUP BY 1, 2`,
  );
  const out = {};
  let backoff = 0;
  for (const g of DRAIN_ORDER) out[g] = {
    queued: 0, running: 0, done: 0, failed: 0,
  };
  for (const row of r.rows) {
    out[row.drain_group] = out[row.drain_group] || {
      queued: 0, running: 0, done: 0, failed: 0,
    };
    out[row.drain_group][row.state] = row.n;
    backoff += row.backoff;
  }
  return { groups: out, backoff };
}

async function recent(db, limit = 50) {
  return (await db.query(
    `SELECT id, batch_id, subject_kind, subject_key, slot, drain_group, state, attempts, last_error, not_before,
            clip_id, updated_at
       FROM audio_jobs ORDER BY updated_at DESC, id DESC LIMIT $1`,
    [limit],
  )).rows;
}

// failed -> queued, attempts reset. Guarded two ways:
//   * the NOT EXISTS clause stops a retry from colliding with a live job for
//     the same slot on audio_jobs_one_live_per_slot;
//   * several failed rows can pile up for one slot (each retry that fails
//     again leaves its own row rather than reusing the old one), and
//     resurrecting all of them would still hit that same unique index the
//     moment the second one flips to 'queued'. Delete the OLDER failed
//     duplicates for a slot first, keeping only the newest, so the slot has
//     at most one failed row left to resurrect.
async function retryFailed(db) {
  await db.query(
    `DELETE FROM audio_jobs a
      WHERE a.state = 'failed'
        AND EXISTS (SELECT 1 FROM audio_jobs b
                     WHERE b.state = 'failed' AND b.subject_kind = a.subject_kind
                       AND b.subject_key = a.subject_key AND b.slot = a.slot AND b.id > a.id)`,
  );
  return (await db.query(
    `UPDATE audio_jobs SET state = 'queued', attempts = 0, not_before = NULL, last_error = NULL, updated_at = now()
      WHERE state = 'failed'
        AND NOT EXISTS (SELECT 1 FROM audio_jobs l WHERE l.state IN ('queued','running')
                          AND l.subject_kind = audio_jobs.subject_kind AND l.subject_key = audio_jobs.subject_key
                          AND l.slot = audio_jobs.slot)`,
  )).rowCount;
}

async function clear(db, { states = ['queued', 'failed', 'done'] } = {}) {
  const allowed = states.filter((s) => s === 'queued' || s === 'failed' || s === 'done');
  if (!allowed.length) return 0;
  return (await db.query('DELETE FROM audio_jobs WHERE state = ANY($1)', [allowed])).rowCount;
}

module.exports = {
  DRAIN_ORDER,
  PACKED_GROUPS,
  SFX_ENGINES,
  MAX_ATTEMPTS,
  drainGroupFor,
  backoffMs,
  enqueue,
  claimNext,
  claimBatch,
  release,
  complete,
  fail,
  requeueOrphans,
  nextClaimableAt,
  stats,
  recent,
  retryFailed,
  clear,
};
