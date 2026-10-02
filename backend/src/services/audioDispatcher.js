// backend/src/services/audioDispatcher.js
//
// Game audio slice 2 (spec §2 "Dispatcher"). The loop that turns queued
// audio_jobs rows into stored clips. Modelled on artDispatcher.js's drain
// half (startDrain/stopDrain/runStatus) -- the differences follow directly
// from audioJobQueue.js's own differences from art's queue:
//   * ONE BOX REQUEST AT A TIME, not a worker pool. Art bounds concurrency
//     because the image box can (carefully) take more than one request; the
//     audio box's queue comment says the same GPU-headroom story applies
//     here. Music/ambience are one job per request; sfx jobs (slice 3) are
//     claimed in batches of up to AUDIO_SFX_PACK_SIZE and sent as ONE
//     sfx-pack request (spec §2 "Packing": one model load for many cues).
//   * GROUPED ORDER (music, ambience, sfx_realistic, sfx_retro) is entirely
//     audioJobQueue's job (claimBatch orders by DRAIN_ORDER, id) -- this
//     file only has to tell a packed (sfx) batch from a single job.
//   * REQUEUE ORPHANS AT EVERY START, same reason as art: nodemon restarts on
//     ANY backend edit, which kills a running drain mid-job and leaves its row
//     stuck in 'running' until something notices. Doing it first, before the
//     first claim, is the restart-recovery step -- a crash never loses a job,
//     only costs it one attempt (audioJobQueue.requeueOrphans refunds that
//     too).
const audioJobQueue = require('./audioJobQueue');
const audioGeneration = require('./audioGeneration');
const { subjectExists } = require('./audioSubjects');

// How many consecutive job failures end the drain rather than working
// through the rest of the queue.
//
// Same reasoning as art's BREAKER_TRIP: one job failing repeatedly is a bad
// subject and the queue's own MAX_ATTEMPTS already caps that (it stops being
// retried and lands in 'failed'). Several DIFFERENT jobs failing back to back
// is the BOX, not the subjects -- and once the box is down, ploughing through
// the rest of the queue just converts every remaining job into a failure at
// whatever rate the box answers, wasting attempts on subjects that were fine.
// Only stopping bounds that; concurrency doesn't apply here since jobs run
// one at a time already.
//
// An unset/blank env var is the normal case (parseInt('', 10) -> NaN) and
// must fall through to the default rather than making the breaker
// unreachable; a hand-typed '0' or negative value is a misconfiguration with
// the same fix.
function envInt(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
const BREAKER_TRIP = () => envInt('AUDIO_BREAKER_TRIP', 3);

// How many sfx jobs one sfx-pack request carries (spec §2 "Packing").
const SFX_PACK_SIZE = () => envInt('AUDIO_SFX_PACK_SIZE', 12);

// The longest the drain will sit waiting for a backoff to expire before
// looking again. Not a cap on the backoff itself (fail() computes that) --
// only on how long a single wait goes without rechecking for a stop request
// or a job whose backoff already passed.
const MAX_WAIT_MS = () => envInt('AUDIO_DRAIN_MAX_WAIT_MS', 60000);

// The floor under any computed idle wait. Without it, clock skew between
// this process and Postgres (or a not_before that SKIP LOCKED just barely
// missed) can compute a wait of 0ms or less, which would turn "sleep until
// the backoff passes" into a tight claim/nextClaimableAt hot loop against the
// database instead of an actual wait.
const MIN_IDLE_WAIT_MS = 250;

// Real defaults. Every DB access, the generate call and the sleep are
// injected as `deps` so a test can drive the loop without a provider or a
// real clock -- `startDrain`'s own test enqueues real rows and fakes only
// `resolveAudioProvider`/`generateForSlot`/`sleep`.
const REAL_DEPS = {
  queue: audioJobQueue,
  generateForSlot: audioGeneration.generateForSlot,
  generateSfxPackForJobs: audioGeneration.generateSfxPackForJobs,
  resolveAudioProvider: audioGeneration.resolveAudioProvider,
  subjectExists,
  sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  now: () => Date.now(),
};

// The deps startDrain falls back to when called without its own. Task 4's
// routes start drains this way, so their tests inject fakes through
// __setDeps rather than threading deps through every route handler.
let defaultDeps = REAL_DEPS;

function __setDeps(deps) {
  defaultDeps = deps ? { ...REAL_DEPS, ...deps } : REAL_DEPS;
}

// Sleep in slices short enough to notice a stop request. `deps.sleep` is the
// primitive (real: setTimeout; test: instant) -- slicing is what makes a
// 60-second real wait interruptible, not the sleep function itself.
const SLICE_MS = 1000;
async function sleepSliced(ms, self, deps) {
  let remaining = ms;
  while (remaining > 0) {
    if (self.stopping) return;
    const step = Math.min(SLICE_MS, remaining);
    // eslint-disable-next-line no-await-in-loop
    await deps.sleep(step);
    remaining -= step;
  }
}

// The NO_PROVIDER precondition, checked once before the loop claims anything.
//
// "No job can resolve a provider" is checked rather than assumed from "no
// active audio provider" alone, because a job can carry its OWN provider_id
// pin that resolves even while nothing is active -- refusing the whole drain
// on that basis would silently strand a perfectly runnable pinned job. Cheap
// and bounded (LIMIT 20 distinct pins): this runs once at drain start, not
// per job, so it does not need to scale with queue size.
async function hasResolvableProvider(db, deps) {
  const active = await deps.resolveAudioProvider(db, null);
  if (active) return true;
  const pinned = await db.query(
    `SELECT DISTINCT provider_id FROM audio_jobs
      WHERE state = 'queued' AND provider_id IS NOT NULL LIMIT 20`,
  );
  for (const row of pinned.rows) {
    // eslint-disable-next-line no-await-in-loop
    if (await deps.resolveAudioProvider(db, row.provider_id)) return true;
  }
  return false;
}

// A job's bookkeeping write (complete/fail) can itself throw -- e.g. FK 23503
// when complete() points at a clip a concurrent delete removed in between.
// Left to the drain's top-level catch, that one write ended the WHOLE drain
// with 'error' and left the job stuck in 'running'. Instead it costs only
// this job: logged, marked failed if the database still lets us, counted as
// failed, and the loop moves on. Returns true when `write` succeeded.
async function bookkeep(db, deps, self, job, write) {
  try {
    await write();
    return true;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error(`audio drain: bookkeeping for job ${job.id} failed`, err);
    try {
      await deps.queue.fail(db, job.id, `bookkeeping failed: ${msg}`, { retryable: false });
    } catch (failErr) {
      // Still 'running'; the next drain's requeueOrphans picks it up.
      console.error(`audio drain: could not mark job ${job.id} failed`, failErr);
    }
    self.failed += 1;
    self.error = msg;
    return false;
  }
}

// BUSY (HTTP 409/503) is the box saying "not now", not "this job is bad" --
// spec §2 draws that line explicitly. A busy answer must not spend an attempt
// and must not count toward the breaker.
function isBusy(result) {
  return Boolean(result.retryable) && (result.status === 409 || result.status === 503);
}

// Only a PROVIDER FAULT counts toward the breaker (busy is handled before
// this is ever asked). A provider fault is any of:
//   * result.retryable -- a transport error, a client-side timeout, or (per
//     callJson) a 409/503 that lost its "busy" status somewhere upstream; all
//     are the box/network, not the subject.
//   * result.status is a 5xx OTHER than 503 (500/502/504/...) -- the box
//     itself errored, even though callJson only marks 409/503 retryable.
//     Missing this was a real gap: a box answering 500 for every subject used
//     to fail every job forever without ever tripping the breaker.
//   * result.providerFault -- remoteAudioProvider's own signal for a fault
//     that isn't an HTTP status at all: unusable JSON, the box's ledger
//     reporting a failed generation (e.g. CUDA OOM), or a returned file that
//     fails the OGG/duration check (the box's output being wrong, not the
//     request).
// A failure with NONE of these (a pinned-but-disabled provider, bad input, a
// subject that no longer exists in the catalogue, an upload-only slot) says
// nothing about the box's health, so it neither trips the breaker nor resets
// the counter -- only a genuine success does that; three unrelated bad
// subjects in a row must not silently reset a count a real outage is
// building toward.
function isProviderFault(result) {
  // A duplicate (SOMET-592, I1: the box answered with a file this slot
  // already has) is retryable but is the box working as designed, not a fault.
  if (result.duplicate) return false;
  return Boolean(result.retryable)
    || (Number.isInteger(result.status) && result.status >= 500 && result.status !== 503)
    || Boolean(result.providerFault);
}

const errorText = (err) => (err && err.message ? err.message : String(err));

// --- The drain --------------------------------------------------------------
//
// One module-level run, same as art's: two drains against one queue is not a
// speed-up (SKIP LOCKED already makes them safe) and would just make "one
// job at a time" a lie by running two boxes' worth of jobs concurrently.
let run = null;

function runStatus() {
  if (!run) {
    return {
      running: false,
      started_at: null,
      finished_at: null,
      done: 0,
      failed: 0,
      retried: 0,
      current: null,
      stopping: false,
      stopped_reason: null,
      error: null,
      requeued_orphans: 0,
    };
  }
  return {
    running: run.running,
    started_at: run.startedAt,
    finished_at: run.finishedAt || null,
    done: run.done,
    failed: run.failed,
    retried: run.retried,
    current: run.current || null,
    stopping: run.stopping,
    stopped_reason: run.stoppedReason || null,
    error: run.error || null,
    requeued_orphans: run.requeuedOrphans,
  };
}

// Flags a stop; the loop checks it before every claim and inside every sleep
// slice, so this is polled rather than cancelling anything in flight -- a job
// already mid-generate finishes (or fails) normally rather than being cut off
// with the box mid-render.
function stopDrain() {
  if (run && run.running) run.stopping = true;
  return runStatus();
}

// Starts a background drain. Returns immediately; poll runStatus().
//
// A PLAIN SYNCHRONOUS FUNCTION: `run` is set, and the loop is kicked off as a
// detached async IIFE, before this returns. That ordering is what makes a
// second call in the same tick see `run.running === true` and throw
// ALREADY_RUNNING -- if `run` were set inside the async body, two calls
// issued back to back (no await between them) would both pass the check.
function startDrain(db, opts = {}) {
  if (run && run.running) {
    const err = new Error('an audio batch is already running');
    err.code = 'ALREADY_RUNNING';
    throw err;
  }

  const deps = opts.deps ? { ...defaultDeps, ...opts.deps } : defaultDeps;

  run = {
    running: true,
    stopping: false,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    done: 0,
    failed: 0,
    retried: 0,
    current: null,
    stoppedReason: null,
    error: null,
    requeuedOrphans: 0,
  };
  const self = run;
  // Distinct from `self.failed`/`self.retried`: those are lifetime totals for
  // the whole drain, this is reset on every success (spec: "reset the
  // consecutive-failure count") and is only what the breaker looks at.
  let consecutiveFailures = 0;

  // A provider fault just happened: 'breaker' when it is the one that trips.
  function recordFault() {
    consecutiveFailures += 1;
    return consecutiveFailures >= BREAKER_TRIP() ? 'breaker' : undefined;
  }

  // One job's failed result -> requeue (retry) or failed, counted.
  async function failJob(job, result, opts = {}) {
    let outcome;
    if (await bookkeep(db, deps, self, job, async () => {
      outcome = await deps.queue.fail(db, job.id, result.error, { retryable: Boolean(result.retryable), ...opts });
    })) {
      if (outcome === 'retry') self.retried += 1; else self.failed += 1;
      self.error = String(result.error);
    }
  }

  // One job's successful result -> done. True when the write succeeded.
  async function completeJob(job, result) {
    if (!(await bookkeep(db, deps, self, job, () => deps.queue.complete(db, job.id, result.clip.id)))) return false;
    self.done += 1;
    return true;
  }

  // Each handler below returns what the loop does next: undefined (claim the
  // next batch), 'pause' (the box was busy: sleep before claiming again, so
  // the very next claim doesn't immediately hammer the same busy box) or
  // 'breaker' (stop the drain).

  // A music/ambience job: one box call.
  async function runSingle(job) {
    self.current = {
      id: job.id,
      subject_kind: job.subject_kind,
      subject_key: job.subject_key,
      slot: job.slot,
      drain_group: job.drain_group,
    };

    // A thrown exception anywhere in resolving the provider or generating
    // the clip is treated as retryable:false with its message -- an
    // unexpected exception is our own bug or a hard box fault, not a "try
    // again in a minute" condition, and it must not take the whole drain
    // down (that is what the top-level catch is for; this one is scoped to a
    // single job).
    let result;
    try {
      // A job can sit queued while its world/biome is deleted or renamed
      // (subjects are keyed by name). Generating for it would burn box time
      // on a clip that can never be bound, so it fails up front --
      // retryable:false with no status/providerFault, so it does not count
      // toward the breaker either.
      const exists = await deps.subjectExists(db, job.subject_kind, job.subject_key);
      // job.provider_id resolves that pin; null falls through to the active
      // audio provider (resolveAudioProvider's own contract).
      const provider = exists ? await deps.resolveAudioProvider(db, job.provider_id ?? null) : null;
      if (!exists) {
        result = { ok: false, error: 'subject no longer exists', retryable: false };
      } else if (!provider) {
        result = { ok: false, error: 'no audio provider', retryable: false };
      } else {
        result = await deps.generateForSlot(db, provider, {
          subjectKind: job.subject_kind,
          subjectKey: job.subject_key,
          slot: job.slot,
          clipKind: job.clip_kind,
          style: job.style,
          prompt: job.prompt,
          slots: job.slots,
          // audio_jobs.seed is bigint; pg returns it as a string, so a bare
          // job.seed would hand generateForSlot "123" instead of 123.
          // Number() on a present seed, undefined (not null) when absent, so
          // generateForSlot's own Number.isInteger check picks a random seed
          // the same way it does for a hand-typed request.
          seed: job.seed == null ? undefined : Number(job.seed),
        });
      }
    } catch (err) {
      result = { ok: false, error: errorText(err), retryable: false };
    }

    if (result.ok) {
      if (await completeJob(job, result)) consecutiveFailures = 0;
      return undefined;
    }
    // Busy: refundAttempt undoes the claim's increment, and it never reaches
    // the breaker -- three subjects in a row failing on a busy box says
    // nothing about whether the box is actually broken.
    if (isBusy(result)) {
      await failJob(job, result, { retryable: true, refundAttempt: true });
      return 'pause';
    }
    await failJob(job, result);
    return isProviderFault(result) ? recordFault() : undefined;
  }

  // An sfx batch (slice 3): every job of one drain group and provider, sent
  // as ONE sfx-pack request. Per-job refusals and per-item failures cost only
  // their own job; a whole-pack failure is ONE provider outcome, so a
  // faulting pack of 12 counts toward the breaker once, not 12 times.
  async function runPack(jobs) {
    const head = jobs[0];
    self.current = {
      id: head.id,
      subject_kind: head.subject_kind,
      subject_key: head.subject_key,
      slot: head.slot,
      drain_group: head.drain_group,
      pack_size: jobs.length,
    };

    const live = [];
    for (const job of jobs) {
      let exists;
      try {
        // eslint-disable-next-line no-await-in-loop
        exists = await deps.subjectExists(db, job.subject_kind, job.subject_key);
      } catch (err) {
        // eslint-disable-next-line no-await-in-loop
        await failJob(job, { error: errorText(err), retryable: false });
        continue;
      }
      if (exists) live.push(job);
      // eslint-disable-next-line no-await-in-loop
      else await failJob(job, { error: 'subject no longer exists', retryable: false });
    }
    if (!live.length) return undefined;

    let out;
    try {
      // claimBatch never mixes provider pins, so the head's pin is the batch's.
      const provider = await deps.resolveAudioProvider(db, head.provider_id ?? null);
      if (!provider) {
        // eslint-disable-next-line no-await-in-loop
        for (const job of live) await failJob(job, { error: 'no audio provider', retryable: false });
        return undefined;
      }
      out = await deps.generateSfxPackForJobs(db, provider, live, {
        // bigint comes back as a string; undefined -> a random seed.
        seed: head.seed == null ? undefined : Number(head.seed),
      });
    } catch (err) {
      const result = { ok: false, error: errorText(err), retryable: false };
      // eslint-disable-next-line no-await-in-loop
      for (const job of live) await failJob(job, result);
      return undefined;
    }

    // Upload-only / cue not offered: never sent, never counted.
    // eslint-disable-next-line no-await-in-loop
    for (const { job, result } of out.refused) await failJob(job, result);
    if (out.packFailure) return settlePackFailure(out.sent, out.packFailure);

    let anyOk = false;
    let anyFault = false;
    for (const { job, result } of out.results) {
      if (result.ok) {
        // eslint-disable-next-line no-await-in-loop
        if (await completeJob(job, result)) anyOk = true;
      } else {
        // eslint-disable-next-line no-await-in-loop
        await failJob(job, result);
        if (isProviderFault(result)) anyFault = true;
      }
    }
    if (anyOk) {
      consecutiveFailures = 0;
      return undefined;
    }
    return anyFault ? recordFault() : undefined;
  }

  // The box refused the pack as a whole; `sent` are the jobs it held.
  async function settlePackFailure(sent, pack) {
    if (isBusy(pack)) {
      // eslint-disable-next-line no-await-in-loop
      for (const { job } of sent) await failJob(job, pack, { retryable: true, refundAttempt: true });
      return 'pause';
    }
    if (pack.unknownCue) {
      // One unknown cue fails the WHOLE pack (spec §2). Only the jobs that
      // sent it are at fault -- our models_cache is stale for that cue, and
      // retrying it would fail the same way. The rest were never tried:
      // released (attempt refunded, no backoff) so the next claim re-sends
      // them without the offending cue.
      const bad = sent.filter((x) => x.cue === pack.unknownCue);
      if (bad.length) {
        // eslint-disable-next-line no-await-in-loop
        for (const { job } of bad) await failJob(job, { error: pack.error, retryable: false });
        const rest = sent.filter((x) => x.cue !== pack.unknownCue).map((x) => x.job);
        try {
          await deps.queue.release(db, rest.map((j) => j.id));
        } catch (err) {
          // Still 'running'; the next drain's requeueOrphans picks them up.
          console.error('audio drain: could not release the rest of an unknown-cue pack', err);
          self.error = errorText(err);
        }
        return undefined;
      }
    }
    // eslint-disable-next-line no-await-in-loop
    for (const { job } of sent) await failJob(job, pack);
    // An unknown cue we never sent is the box misbehaving, not our request.
    return isProviderFault(pack) || pack.unknownCue ? recordFault() : undefined;
  }

  (async () => {
    try {
      // RESTART RECOVERY, BEFORE the NO_PROVIDER precondition. A nodemon
      // reload (any backend edit) kills a running drain mid-job and leaves
      // its row stuck in 'running'; requeueing it first means a crash never
      // loses a job (only costs it one refunded attempt) AND means the
      // precondition below sees that row as 'queued' -- an orphan whose own
      // provider_id pin is the only thing that resolves must not be mistaken
      // for "nothing to run".
      self.requeuedOrphans = await deps.queue.requeueOrphans(db);

      const resolvable = await hasResolvableProvider(db, deps);
      if (!resolvable) {
        const err = new Error(
          'no audio provider is active and no queued job pins one that resolves',
        );
        err.code = 'NO_PROVIDER';
        throw err;
      }

      for (;;) {
        if (self.stopping) { self.stoppedReason = 'stopped'; break; }

        // eslint-disable-next-line no-await-in-loop
        const jobs = await deps.queue.claimBatch(db, SFX_PACK_SIZE());
        if (!jobs.length) {
          // Nothing claimable does not mean the queue is empty -- it also
          // happens when every remaining job is sitting out its retry
          // backoff. Ending the drain on that would silently strand a queue
          // full of retryable jobs; nextClaimableAt tells the two apart.
          // eslint-disable-next-line no-await-in-loop
          const next = await deps.queue.nextClaimableAt(db);
          if (!next) { self.stoppedReason = 'empty'; break; }
          const rawWaitMs = new Date(next).getTime() - deps.now();
          const waitMs = Math.min(Math.max(rawWaitMs, MIN_IDLE_WAIT_MS), MAX_WAIT_MS());
          // eslint-disable-next-line no-await-in-loop
          await sleepSliced(waitMs, self, deps);
          if (self.stopping) { self.stoppedReason = 'stopped'; break; }
          continue;
        }

        // eslint-disable-next-line no-await-in-loop
        const next = audioJobQueue.PACKED_GROUPS.includes(jobs[0].drain_group)
          ? await runPack(jobs)
          : await runSingle(jobs[0]);
        self.current = null;
        if (next === 'breaker') { self.stoppedReason = 'breaker'; break; }
        if (next === 'pause') {
          // eslint-disable-next-line no-await-in-loop
          await sleepSliced(deps.queue.backoffMs(1), self, deps);
          if (self.stopping) { self.stoppedReason = 'stopped'; break; }
        }
      }
    } catch (err) {
      // Anything that escaped the per-job handlers above (requeueOrphans,
      // claimBatch, the NO_PROVIDER precondition, a DB connection drop) ends
      // the whole drain rather than the loop retrying forever against a
      // database it can no longer reach.
      self.error = err && err.message ? err.message : String(err);
      if (err && err.code === 'NO_PROVIDER') self.stoppedReason = 'no_provider';
      else if (!self.stoppedReason) self.stoppedReason = 'error';
    } finally {
      self.current = null;
      self.running = false;
      self.finishedAt = new Date().toISOString();
    }
  })();

  return runStatus();
}

// Tests only: forget the run so one case cannot leave another looking busy.
function __resetRun() { run = null; }

module.exports = {
  startDrain,
  stopDrain,
  runStatus,
  __resetRun,
  __setDeps,
  // Exported so audioRoutes.js's dispatch/enqueue-with-start preflight (the
  // "would startDrain immediately hit NO_PROVIDER?" check, answered BEFORE
  // starting rather than discovered asynchronously) shares this exact
  // precondition instead of carrying its own copy of the same query and
  // active-then-pinned loop. Callers outside startDrain pass their own
  // `deps` (at least a `resolveAudioProvider`); REAL_DEPS is only the
  // fallback startDrain itself uses.
  hasResolvableProvider,
};
