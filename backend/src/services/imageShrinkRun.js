'use strict';
// Batch runner for the Images tab: shrink or undo a list of subjects one at a
// time. In-memory and single-flight, like bulkImageRegeneration -- deliberately
// NOT seedSync/jobs.js, which would block Seed/Export while images shrink.
// A backend restart forgets the progress bar, not the work: every subject's
// result is already in image_operations. Callable without HTTP (actor: null).
// The auto-shrink sweep runs through here too: `auto: true` (actor forced
// null, ops logged with params.auto) and per-subject params (a subject's own
// `params` property wins over the run's).

const crypto = require('node:crypto');
const { shrinkSubject, undoSubject, invalidateServeMap } = require('./imageVariants.js');

const OPS = Object.freeze(['shrink', 'undo']);
let current = null;

function publicView(run) {
  if (!run) return null;
  return {
    id: run.id,
    op: run.op,
    total: run.total,
    done: run.done,
    failed: run.failed,
    status: run.status,
    auto: run.auto,
    error: run.error,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

function getRun() {
  return publicView(current);
}

function cancelRun() {
  if (!current || current.status !== 'running') return null;
  current.cancelRequested = true;
  return publicView(current);
}

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

async function drive(pool, store, run, subjects, params) {
  try {
    for (const item of subjects) {
      if (run.cancelRequested) break;
      const subject = { table: item.table, key: item.key, column: item.column };
      const p = own(item, 'params') ? item.params : params;
      const ctx = { actor: run.actor, batchId: run.id, auto: run.auto };
      let op = null;
      try {
        op = run.op === 'shrink'
          ? await shrinkSubject(pool, store, subject, p, ctx)
          : await undoSubject(pool, subject, ctx);
      } catch (err) {
        // No image library: every subject would fail the same way. Stop the
        // run with one run-level error instead of failing each row.
        if (err && err.code === 'shrinker_unavailable') throw err;
        // An unknown table/column: nothing was logged, count it as failed.
        console.error('image run subject failed', err && err.message);
      }
      run.done += 1;
      if (!op || op.status !== 'ok') run.failed += 1;
    }
  } catch (err) {
    console.error('image run crashed', err && err.message);
    run.error = (err && err.message) || String(err);
  } finally {
    run.status = run.cancelRequested ? 'cancelled' : 'done';
    run.finishedAt = new Date().toISOString();
    invalidateServeMap();
  }
}

// Returns the view, or throws an Error with .code 'running' / 'bad_request'.
async function startRun(pool, store, { op, subjects, params = null, actor = null, auto = false } = {}) {
  if (!OPS.includes(op)) throw Object.assign(new Error('op must be shrink or undo'), { code: 'bad_request' });
  if (!Array.isArray(subjects) || subjects.length === 0) {
    throw Object.assign(new Error('subjects must be a non-empty array'), { code: 'bad_request' });
  }
  if (current && current.status === 'running') {
    throw Object.assign(new Error('run in progress'), { code: 'running' });
  }
  const run = {
    id: crypto.randomUUID(),
    op,
    actor: auto ? null : actor,
    auto: Boolean(auto),
    error: null,
    total: subjects.length,
    done: 0,
    failed: 0,
    status: 'running',
    cancelRequested: false,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  current = run;
  // drive records its own crash; this catch only keeps a rejection from going unhandled.
  drive(pool, store, run, subjects, params).catch((err) => console.error('image run crashed', err && err.message));
  return publicView(run);
}

function resetForTests() {
  current = null;
}

module.exports = { startRun, getRun, cancelRun, resetForTests };
