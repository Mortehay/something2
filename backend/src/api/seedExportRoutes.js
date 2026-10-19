// SOMET-637. Admin API over the seed/export engine (services/seedSync). Every
// route is admin-only. Errors: SyncRefused -> 409 (busy -> { error: 'busy',
// job }), SyncFileError -> 422, unknown group -> 404, anything else -> 500
// with no internals.
//
// SOMET-640: export / seed of a `binary` group (art, audio) -- or a group
// flagged `job` (maps, SOMET-641) -- runs as a background job (seedSync/jobs.js) and answers 202 { job }; the tab polls
// GET jobs/current. Data groups stay synchronous (200). While a job runs every
// export / seed answers 409 busy.
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { requireAdmin } = require('../auth/middleware.js');
const { GROUPS, getGroup } = require('../services/seedSync/registry.js');
const { diffGroup } = require('../services/seedSync/diffGroup.js');
const { previewSeed, applySeed } = require('../services/seedSync/applySeed.js');
const { exportGroup } = require('../services/seedSync/exportGroup.js');
const { lastRuns, recentRuns, pcLabel, pcLabelSet } = require('../services/seedSync/runs.js');
const { SyncRefused, SyncFileError } = require('../services/seedSync/errors.js');
const jobs = require('../services/seedSync/jobs.js');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZERO_COUNTS = {};

function triggerPath() {
  return process.env.SEED_RESTART_TRIGGER || path.join(__dirname, '..', 'restart-trigger.json');
}

function sendError(res, err) {
  // The job runner's busy carries the running job. The engine's own 'busy'
  // (lock timeout, txn.js) has none and keeps the generic 409 body below.
  if (err instanceof SyncRefused && err.code === 'busy' && err.details && 'job' in err.details) {
    return res.status(409).json({ error: 'busy', job: err.details.job });
  }
  if (err instanceof SyncRefused) {
    return res.status(409).json({ error: err.message, code: err.code, details: err.details });
  }
  if (err instanceof SyncFileError) {
    return res.status(422).json({ error: err.message, code: 'bad_file', file: err.file });
  }
  if (err && err.message === 'unknown group') return res.status(404).json({ error: 'unknown group' });
  console.error('seed-export route failed', err);
  return res.status(500).json({ error: 'seed/export failed' });
}

function validDecisions(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
  return Object.entries(d).every(([k, v]) => UUID_RE.test(k) && typeof v === 'string');
}

// Groups whose export / seed run as a background job: the binary groups
// (asset files) and any group flagged `job` (maps: whole-map rebuilds).
const runsAsJob = (g) => Boolean(g.binary || g.job);

function refuseIfBusy() {
  if (jobs.isBusy()) throw new SyncRefused('busy', 'another export or seed is running', { job: jobs.currentJob() });
}

// opts.store: the object store binary groups read / write (default: the
// engine's, assetStore.js); tests inject a fake.
module.exports = function seedExportRoutes(pool, { processStartedAt, store } = {}) {
  const router = express.Router();
  router.use(requireAdmin(pool));

  const storeOpt = store ? { store } : {};
  const handler = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (err) { sendError(res, err); }
  };
  // 404 before any engine work.
  const withGroup = (fn) => handler(async (req, res) => {
    getGroup(req.params.id);
    await fn(req, res);
  });

  router.get('/groups', handler(async (req, res) => {
    const runs = await lastRuns(pool);
    const out = [];
    for (const g of GROUPS) {
      const last = runs[g.id] || {};
      const base = {
        id: g.id, label: g.label, binary: Boolean(g.binary), job: runsAsJob(g),
        lastExport: last.export || null, lastSeed: last.seed || null,
      };
      try {
        const d = await diffGroup(pool, g.id);
        out.push({
          ...base,
          status: d.status,
          counts: d.counts,
          localEdits: d.localEdits,
          gitChanges: d.gitChanges,
          tokensMissing: d.tokensMissing,
          inGit: d.header || null,
          // An adapter group's note for the badge (maps: baseline_pending).
          ...(d.hint ? { hint: d.hint } : {}),
        });
      } catch (err) {
        if (!(err instanceof SyncFileError)) throw err;
        out.push({
          ...base,
          status: 'bad_file',
          error: err.message,
          file: err.file,
          counts: ZERO_COUNTS,
          localEdits: 0,
          gitChanges: 0,
          tokensMissing: 0,
          inGit: null,
        });
      }
    }
    res.json(out);
  }));

  // Which PC exports say they came from; the tab hints when it is unset.
  router.get('/meta', handler(async (req, res) => {
    res.json({ pcLabel: pcLabel(), pcLabelSet: pcLabelSet() });
  }));

  router.get('/groups/:id/preview', withGroup(async (req, res) => {
    res.json(await previewSeed(pool, req.params.id));
  }));

  router.post('/groups/:id/export', withGroup(async (req, res) => {
    const groupId = req.params.id;
    refuseIfBusy();
    if (runsAsJob(getGroup(groupId))) {
      const job = jobs.startJob({
        groupId, action: 'export', run: (ctx) => exportGroup(pool, groupId, { ...storeOpt, ...ctx }),
      });
      return res.status(202).json({ job });
    }
    res.json(await exportGroup(pool, groupId));
  }));

  router.post('/groups/:id/seed', withGroup(async (req, res) => {
    const decisions = req.body && req.body.decisions;
    if (!validDecisions(decisions)) {
      return res.status(400).json({ error: 'decisions must be an object of row uuid -> decision string' });
    }
    // The preview's signature: apply refuses (stale_preview) if the diff moved.
    const signature = req.body.signature;
    if (typeof signature !== 'string' || !signature) {
      return res.status(400).json({ error: 'signature (from the preview) is required' });
    }
    const groupId = req.params.id;
    refuseIfBusy();
    if (runsAsJob(getGroup(groupId))) {
      // Engine refusals (stale_preview, undecided, ...) end the job failed
      // with errorCode; the tab shows them.
      const job = jobs.startJob({
        groupId, action: 'seed', run: (ctx) => applySeed(pool, groupId, decisions, { signature, ...storeOpt, ...ctx }),
      });
      return res.status(202).json({ job });
    }
    res.json(await applySeed(pool, groupId, decisions, { signature }));
  }));

  // null until the first job of this process; the last job stays visible
  // until the next one starts.
  router.get('/jobs/current', handler(async (req, res) => {
    res.json(jobs.currentJob());
  }));

  // Honoured only before the engine's locked transaction begins; after that
  // the run completes. Idempotent: idle answers cancelled:false.
  router.post('/jobs/cancel', handler(async (req, res) => {
    const cancelled = jobs.cancelJob();
    res.json({ cancelled, job: jobs.currentJob() });
  }));

  router.get('/runs', handler(async (req, res) => {
    const groupId = req.query.group ? String(req.query.group) : undefined;
    if (groupId) getGroup(groupId);
    const n = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(n) ? Math.min(200, Math.max(1, n)) : 15;
    let offset = 0;
    if (req.query.offset !== undefined) {
      const raw = req.query.offset;
      offset = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isSafeInteger(offset)) {
        return res.status(400).json({ error: 'offset must be a non-negative integer' });
      }
    }
    // { runs: [...newest first], total } -- total counts runs matching `group`.
    res.json(await recentRuns(pool, { limit, offset, groupId }));
  }));

  router.get('/restart', handler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT EXISTS (SELECT 1 FROM seed_export_runs
                       WHERE action = 'seed' AND status = 'ok' AND finished_at > $1) AS required`,
      [processStartedAt || new Date(0)],
    );
    res.json({ required: rows[0].required });
  }));

  // nodemon watches src/**/*.json (nodemon.json): rewriting this file restarts
  // the dev backend. There is no compose restart policy to lean on.
  router.post('/restart', handler(async (req, res) => {
    fs.writeFileSync(triggerPath(), `${JSON.stringify({ at: new Date().toISOString() })}\n`);
    res.json({ ok: true });
  }));

  return router;
};

module.exports.sendError = sendError; // tests
