'use strict';
// Batch runner for the Images tab: shrink or undo a list of subjects one at a
// time. In-memory and single-flight, like bulkImageRegeneration -- deliberately
// NOT seedSync/jobs.js, which would block Seed/Export while images shrink.
// A backend restart forgets the progress bar, not the work: every subject's
// result is already in image_operations. Callable without HTTP (actor: null).

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

async function drive(pool, store, run, subjects, params) {
  for (const subject of subjects) {
    if (run.cancelRequested) break;
    const ctx = { actor: run.actor, batchId: run.id };
    let op = null;
    try {
      op = run.op === 'shrink'
        ? await shrinkSubject(pool, store, subject, params, ctx)
        : await undoSubject(pool, subject, ctx);
    } catch (err) {
      // An unknown table/column: nothing was logged, count it as failed.
      console.error('image run subject failed', err && err.message);
    }
    run.done += 1;
    if (!op || op.status !== 'ok') run.failed += 1;
  }
  run.status = run.cancelRequested ? 'cancelled' : 'done';
  run.finishedAt = new Date().toISOString();
  invalidateServeMap();
}

// Returns the view, or throws an Error with .code 'running' / 'bad_request'.
async function startRun(pool, store, { op, subjects, params = null, actor = null } = {}) {
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
    actor,
    total: subjects.length,
    done: 0,
    failed: 0,
    status: 'running',
    cancelRequested: false,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  current = run;
  drive(pool, store, run, subjects, params).catch((err) => {
    console.error('image run crashed', err && err.message);
    run.status = 'done';
    run.finishedAt = new Date().toISOString();
  });
  return publicView(run);
}

function resetForTests() {
  current = null;
}

module.exports = { startRun, getRun, cancelRun, resetForTests };
