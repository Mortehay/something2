// SOMET-640 (plan 3). In-process, single-flight background jobs for the binary
// seed-sync groups (art, audio): their export / seed downloads or uploads every
// asset file, far too long for one HTTP request. The route starts a job and
// answers 202; the tab polls currentJob(). One job at a time per backend
// process; while it runs, every export / seed (binary or not) is refused busy.
//
// State is memory only: a restart loses the job (the engine's run row, if one
// was started, is marked failed at boot by runs.markInterruptedRuns).
//
// Cancel aborts the job's signal. The engine checks it between asset files,
// i.e. only BEFORE its locked transaction; once that is open the run
// completes (and the job ends ok). The engine starts its run row inside the
// transaction, so a cancelled job never has a run row: the job state alone
// says "cancelled".
const { SyncRefused } = require('./errors.js');

let seq = 0;
let current = null; // { ...public fields, controller }

function view(job) {
  if (!job) return null;
  const { controller, ...pub } = job;
  return { ...pub };
}

const currentJob = () => view(current);
const isBusy = () => Boolean(current && current.status === 'running');

function settle(job, fields) {
  Object.assign(job, fields, { finishedAt: new Date().toISOString() });
}

// run(ctx) -> Promise<result>, ctx = { onProgress({ phase, done, total }), signal }.
// Never rejects: the outcome is recorded on the job.
function startJob({ groupId, action, run }) {
  if (isBusy()) throw new SyncRefused('busy', 'another export or seed is running', { job: currentJob() });
  const controller = new AbortController();
  seq += 1;
  const job = {
    id: seq,
    groupId,
    action,
    phase: null,
    done: 0,
    total: 0,
    status: 'running',
    error: null,
    errorCode: null,
    errorDetails: null,
    result: null,
    cancelRequested: false,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    controller,
  };
  current = job;
  const onProgress = (p) => {
    if (!p || job.status !== 'running') return;
    job.phase = p.phase ?? job.phase;
    job.done = Number.isFinite(p.done) ? p.done : job.done;
    job.total = Number.isFinite(p.total) ? p.total : job.total;
  };
  Promise.resolve()
    .then(() => run({ onProgress, signal: controller.signal }))
    .then((result) => settle(job, { status: 'ok', result: result ?? null }))
    .catch((err) => {
      if (err instanceof SyncRefused && err.code === 'cancelled') {
        settle(job, { status: 'cancelled' });
      } else if (err && typeof err.code === 'string' && (err.name === 'SyncRefused' || err.name === 'SyncFileError')) {
        // Refusals carry user-facing text (the route's 409/422 bodies).
        settle(job, {
          status: 'failed', error: err.message, errorCode: err.code, errorDetails: err.details || (err.file ? { file: err.file } : null),
        });
      } else {
        console.error(`seed-sync: ${action} job for ${groupId} failed`, err);
        settle(job, { status: 'failed', error: 'seed/export failed' });
      }
    })
    .catch((err) => console.error('seed-sync: job bookkeeping failed', err));
  return view(job);
}

// true when a running job was asked to stop.
function cancelJob() {
  if (!isBusy()) return false;
  current.cancelRequested = true;
  current.controller.abort();
  return true;
}

module.exports = { startJob, currentJob, cancelJob, isBusy };
