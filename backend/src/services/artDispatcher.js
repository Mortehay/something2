const queue = require('./artJobQueue.js');
const remote = require('./remoteImageProvider.js');

// SOMET-540. The loop that turns queued art jobs into images.
//
// It owns almost no logic of its own, and that is the design. The provider
// call already exists in remoteImageProvider (template substitution, auth,
// safeFetch, size caps, image decode, sheet manifest, storage write) and is
// well covered; re-implementing any of it here would create a second path
// that drifts. This module is the part that was missing: deciding what to work
// on next, running a bounded number at once, and recording the outcome
// durably.
//
// HOW THE TWO JOB CONCEPTS FIT TOGETHER, because there are deliberately two.
// remoteImageProvider's in-memory registry tracks ONE generation so the admin
// UI can poll it; art_jobs tracks the BATCH so it survives a restart. The
// dispatcher creates a registry job per attempt, runs it, reads the verdict,
// and writes that verdict to the durable row. Neither replaces the other.

// A cap, not a target. The remote decides how much parallelism actually helps;
// this only stops us from opening 617 sockets at once.
const DEFAULT_CONCURRENCY = () => parseInt(process.env.ART_DISPATCH_CONCURRENCY || '2', 10);

// Run one claimed job to completion and record the outcome.
//
// `generate` is injected so a test can drive this without a provider. The
// default is the real thing; a stub in a test asserts the dispatcher's own
// behaviour rather than re-testing the provider call.
async function runOne(db, job, { provider, generate = remote.runGeneration, buildRequest }) {
  const registryId = remote.createJob();
  try {
    await generate(registryId, provider, buildRequest(job), {});
  } catch (err) {
    // runGeneration reports failure through the registry rather than throwing,
    // so reaching here means something unexpected escaped it. Recorded as a
    // normal failure: an exception must not take the loop down and leave the
    // row stuck in `running` until requeueStale notices.
    await queue.fail(db, job.id, err);
    return { id: job.id, ok: false, error: String(err && err.message ? err.message : err) };
  }
  const doc = remote.getJob(registryId);
  // A missing doc means the registry evicted it mid-run (it is TTL- and
  // size-bounded). Treated as a failure rather than a success: we cannot see
  // that an image was stored, and marking done on no evidence is exactly the
  // "green over nothing" shape this repo keeps finding.
  if (!doc) {
    await queue.fail(db, job.id, new Error('generation result was evicted before it could be read'));
    return { id: job.id, ok: false, error: 'result evicted' };
  }
  if (doc.status === 'done') {
    await queue.complete(db, job.id);
    return { id: job.id, ok: true, result: doc.result };
  }
  await queue.fail(db, job.id, new Error(doc.error || 'generation failed with no reason given'));
  return { id: job.id, ok: false, error: doc.error };
}

// Claim and run up to `limit` jobs, at most `concurrency` at a time.
//
// Returns what it did, so a caller (an admin endpoint, a CLI, a test) can
// report honestly rather than guessing. Nothing here loops forever: a batch is
// driven by calling this repeatedly, which keeps the scheduling decision --
// how often, for how long, whether to stop -- with the caller instead of
// burying it in a daemon.
async function dispatch(db, {
  provider,
  limit = 10,
  concurrency = DEFAULT_CONCURRENCY(),
  generate,
  buildRequest,
} = {}) {
  const claimed = await queue.claim(db, limit);
  if (claimed.length === 0) return { claimed: 0, done: 0, failed: 0, results: [] };

  const results = [];
  let cursor = 0;
  // A fixed pool of workers pulling from a shared cursor, rather than slicing
  // the list into equal chunks: subjects do not take equal time, and chunking
  // would leave one worker finishing long after the others idled.
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= claimed.length) return;
      results.push(await runOne(db, claimed[i], { provider, generate, buildRequest }));
    }
  });
  await Promise.all(workers);

  return {
    claimed: claimed.length,
    done: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

module.exports = { dispatch, runOne, DEFAULT_CONCURRENCY };
