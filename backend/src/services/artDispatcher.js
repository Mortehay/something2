const queue = require('./artJobQueue.js');
const remote = require('./remoteImageProvider.js');
const catalogSubjects = require('./catalogSubjects.js');
const { pngHasAlpha, readObjectHead } = require('./bulkImageRegeneration.js');
const { buildObjectPrompt } = require('./objectPrompt.js');

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

// --- The resolution precondition ------------------------------------------
//
// THE MOST EXPENSIVE MISTAKE AVAILABLE HERE, measured 2026-09-04 (SOMET-536).
//
// SDXL trains at 1024. Asked for one object at 512 -- half that -- it does not
// draw a smaller object, it REPEATS the object: a 3x4 sprite sheet, an
// inventory panel, or a scene with a floor. Same checkpoint, same prompts,
// same seeds, resolution the only variable: 2 of 8 subjects usable at 512,
// 6 of 8 at 1024. At 512 the cutout could not key most of them either, because
// the model paints a panel instead of the flat backdrop the keying depends on.
//
// This is worth a hard precondition rather than a comment because the failure
// is invisible in aggregate: 617 sprite sheets look like 617 images and the
// job rows all say `done`. Nothing downstream can tell the difference, and the
// error is only discoverable by eye, one subject at a time.
const MIN_OBJECT_PX = () => parseInt(process.env.ART_MIN_OBJECT_PX || '1024', 10);

// What will ACTUALLY be sent for a dimension.
//
// remoteImageProvider only substitutes {{placeholders}}; a template that
// hardcodes `"width": 512` sends 512 no matter what the caller asks for, so
// reading the request is not enough -- the template has to be read.
//
// Returns null when the answer is not knowable: a missing key means the remote
// applies its own default, which we cannot see from here.
function templatePx(provider, key) {
  const t = provider && provider.request_template;
  if (!t || typeof t !== 'object') return null;
  const v = t[key];
  if (typeof v === 'number') return v;
  // A placeholder means WE choose the value, so it is not a refusal case.
  if (typeof v === 'string' && /^\{\{\s*\w+\s*\}\}$/.test(v.trim())) return null;
  if (typeof v === 'string' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

// Refuse only what we can positively see is too small.
//
// The same rule the entity alpha guard already follows -- "a header we cannot
// parse is NOT treated as a failure" -- for the same reason: this exists to
// catch one known, specific misconfiguration, not to reject every provider
// whose template it cannot fully read.
function providerSizeRefusal(provider, minPx = MIN_OBJECT_PX()) {
  const w = templatePx(provider, 'width');
  const h = templatePx(provider, 'height');
  const seen = [w, h].filter((n) => Number.isFinite(n));
  if (seen.length === 0) return null;
  const smallest = Math.min(...seen);
  if (smallest >= minPx) return null;
  return `provider "${provider && provider.name ? provider.name : provider && provider.id}" `
    + `renders at ${w || '?'}x${h || '?'}, below the ${minPx}px minimum for an isolated object. `
    + 'Below SDXL\'s native resolution the model repeats the subject -- it returns a sprite '
    + 'sheet or a panel rather than one object, and the cutout cannot key it. '
    + `Set the provider's request_template width/height to ${minPx}, or use "{{width}}"/"{{height}}" `
    + 'to let the caller choose.';
}

// --- Subjects -------------------------------------------------------------
//
// A job row stores only (kind, key, seed) -- deliberately not the prompt. The
// prompt is composed from code, so fixing a prompt applies to jobs that are
// already queued rather than to the next batch only.
//
// Memoised per dispatch call: `list` is one query for a whole kind, and
// resolving 617 jobs one at a time would be 617 full-catalogue queries.
function subjectResolver(db, subjects = catalogSubjects) {
  const byKind = new Map();
  return async function get(kind, key) {
    if (!byKind.has(kind)) {
      const reg = subjects.registryFor(kind);
      if (!reg) throw new Error(`unknown subject kind: ${kind}`);
      const list = await reg.list(db);
      byKind.set(kind, new Map(list.map((s) => [s.key, s])));
    }
    return byKind.get(kind).get(key) || null;
  };
}

// The base prompt is a PLAIN SUBJECT and buildObjectPrompt adds the framing --
// the wrapper is shared with the entity path on purpose, so icons and world
// props are not two divergent house styles. See catalogSubjects.js's header
// for why a base that carries its own styling fights this.
//
// `kind: 'object'` is the GENERATION kind (isolated, needs a cutout), which is
// a different axis from the subject kind: an item, a skill and a passive label
// are all objects to draw.
function requestForSubject(job, subject) {
  return {
    subject: subject.name || subject.key,
    kind: 'object',
    prompt: buildObjectPrompt(subject.basePrompt),
    seed: Number(job.seed),
    frames: 1,                       // never a sheet
    width: MIN_OBJECT_PX(),          // honoured only by a {{width}} template
    height: MIN_OBJECT_PX(),
  };
}

// --- One job --------------------------------------------------------------

// Run one claimed job to completion and record the outcome.
//
// `generate`, `buildRequest` and `writeArt` are injected so a test can drive
// this without a provider. The defaults are the real thing; a stub asserts the
// dispatcher's own behaviour rather than re-testing the provider call.
async function runOne(db, job, {
  provider,
  generate = remote.runGeneration,
  buildRequest,
  writeArt,
  resolveSubject,
  deps = {},
} = {}) {
  const fail = async (message) => {
    await queue.fail(db, job.id, new Error(message));
    return { id: job.id, ok: false, error: message };
  };

  let req;
  if (buildRequest) {
    req = await buildRequest(job);
  } else {
    const subject = await resolveSubject(job.subject_kind, job.subject_key);
    // A queued subject that no longer exists is a failure with a reason, not a
    // crash: labels move when the passive tree is reseeded, and a catalogue
    // row can be renamed between enqueue and dispatch.
    if (!subject) {
      return fail(`subject ${job.subject_kind}/${job.subject_key} is no longer in the catalogue`);
    }
    req = requestForSubject(job, subject);
    job.__subject = subject;
  }

  const registryId = remote.createJob();
  try {
    await generate(registryId, provider, req, deps);
  } catch (err) {
    // runGeneration reports failure through the registry rather than throwing,
    // so reaching here means something unexpected escaped it. Recorded as a
    // normal failure: an exception must not take the loop down and leave the
    // row stuck in `running` until requeueStale notices.
    return fail(String(err && err.message ? err.message : err));
  }
  const doc = remote.getJob(registryId);
  // A missing doc means the registry evicted it mid-run (it is TTL- and
  // size-bounded). Treated as a failure rather than a success: we cannot see
  // that an image was stored, and marking done on no evidence is exactly the
  // "green over nothing" shape this repo keeps finding.
  if (!doc) return fail('generation result was evicted before it could be read');
  if (doc.status !== 'done') {
    return fail(doc.error || 'generation failed with no reason given');
  }

  const imageKey = doc.result && doc.result.image_key;
  // Done with nothing to point at is not done. Without this the queue would
  // report a perfect batch while every subject still rendered as a blank slot.
  if (!imageKey) return fail('generation finished without an image_key');

  const write = writeArt || defaultWriteArt;
  try {
    await write(db, job, imageKey, { provider, deps });
  } catch (err) {
    return fail(`image ${imageKey} was generated but could not be recorded: `
      + `${err && err.message ? err.message : err}`);
  }

  await queue.complete(db, job.id);
  return { id: job.id, ok: true, imageKey, result: doc.result };
}

// Point the subject at its new image, through SOMET-535's registry -- items
// write item_types.icon, skills and passive labels write catalog_art.
//
// THE ALPHA GUARD, same rule and same reasoning as bulkImageRegeneration's:
// every subject here is an isolated object, Stable Diffusion has no alpha
// channel, and an opaque square renders as a grey block in an icon slot. Only
// a PNG that positively says "no alpha" is refused; a header we cannot read is
// allowed through, because this catches one known failure rather than
// everything unfamiliar.
async function defaultWriteArt(db, job, imageKey, { provider, deps = {} } = {}) {
  const head = await readObjectHead(imageKey, deps.store).catch(() => null);
  if (pngHasAlpha(head) === false) {
    throw new Error('the provider returned an image with no transparency; an icon '
      + 'must be a cutout or it renders as an opaque square');
  }
  const reg = catalogSubjects.registryFor(job.subject_kind);
  if (!reg) throw new Error(`unknown subject kind: ${job.subject_kind}`);
  await reg.write(db, job.subject_key, imageKey, provider ? provider.id : null);
}

// --- The batch ------------------------------------------------------------

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
  writeArt,
  subjects = catalogSubjects,
  deps = {},
} = {}) {
  // Checked BEFORE claiming, so a misconfigured provider costs nothing and
  // leaves the queue untouched rather than burning an attempt on every row.
  // Skipped when the caller builds its own requests -- it is then not this
  // module's business what gets sent.
  if (!buildRequest) {
    const refusal = providerSizeRefusal(provider);
    if (refusal) {
      const err = new Error(refusal);
      err.code = 'PROVIDER_TOO_SMALL';
      throw err;
    }
  }

  const claimed = await queue.claim(db, limit);
  if (claimed.length === 0) return { claimed: 0, done: 0, failed: 0, results: [] };

  const resolveSubject = subjectResolver(db, subjects);
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
      results.push(await runOne(db, claimed[i], {
        provider, generate, buildRequest, writeArt, resolveSubject, deps,
      }));
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

module.exports = {
  dispatch,
  runOne,
  DEFAULT_CONCURRENCY,
  MIN_OBJECT_PX,
  providerSizeRefusal,
  requestForSubject,
  subjectResolver,
};

// --- The drain ------------------------------------------------------------
//
// `dispatch` deliberately does one bounded pass, so the scheduling decision
// stays with the caller. But the caller here is an HTTP request, and a batch
// is hours long at ~20s an image -- so ONE caller expresses that decision once,
// and this keeps pulling until the queue is empty or someone stops it.
//
// Not a queue of its own and not a counter: progress is read from the catalog
// (does this subject have art?) and from art_jobs, both of which are the truth.
// This object only answers "is something running right now, and why did it
// stop", which nothing else can tell you.
let run = null;

function runStatus() {
  if (!run) return { running: false, last: null };
  return {
    running: run.running,
    started_at: run.startedAt,
    finished_at: run.finishedAt || null,
    passes: run.passes,
    done: run.done,
    failed: run.failed,
    stopping: run.stopping,
    error: run.error || null,
  };
}

function stopDrain() {
  if (!run || !run.running) return false;
  run.stopping = true;
  return true;
}

// Starts a background drain. Returns immediately; poll runStatus().
//
// Refuses to start a second one, because two drains against one queue is not a
// speed-up -- SKIP LOCKED already makes them safe, but they would compete for
// the same remote and make the concurrency cap a lie.
function startDrain(db, opts = {}) {
  if (run && run.running) {
    const err = new Error('an art batch is already running');
    err.code = 'ALREADY_RUNNING';
    throw err;
  }
  // The precondition is checked HERE, synchronously, so a misconfigured
  // provider is a 400 on the request that started it rather than an error
  // buried in a status poll nobody reads.
  if (!opts.buildRequest) {
    const refusal = providerSizeRefusal(opts.provider);
    if (refusal) {
      const err = new Error(refusal);
      err.code = 'PROVIDER_TOO_SMALL';
      throw err;
    }
  }

  run = {
    running: true, stopping: false, startedAt: new Date().toISOString(),
    finishedAt: null, passes: 0, done: 0, failed: 0, error: null,
  };
  const self = run;

  (async () => {
    try {
      for (;;) {
        if (self.stopping) break;
        const out = await dispatch(db, opts);
        self.passes += 1;
        self.done += out.done;
        self.failed += out.failed;
        // Nothing claimed means the queue is empty. Stopping here rather than
        // polling for new work keeps this a BATCH, not a daemon: enqueueing
        // more is an explicit act that starts another drain.
        if (out.claimed === 0) break;
      }
    } catch (err) {
      self.error = err && err.message ? err.message : String(err);
    } finally {
      self.running = false;
      self.finishedAt = new Date().toISOString();
    }
  })();

  return runStatus();
}

// Tests only: forget the run so one case cannot leave another looking busy.
function __resetRun() { run = null; }

module.exports.startDrain = startDrain;
module.exports.stopDrain = stopDrain;
module.exports.runStatus = runStatus;
module.exports.__resetRun = __resetRun;
