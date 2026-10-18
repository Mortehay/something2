// SOMET-637. Admin API over the seed/export engine (services/seedSync). Every
// route is admin-only. Errors: SyncRefused -> 409, SyncFileError -> 422,
// unknown group -> 404, anything else -> 500 with no internals.
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZERO_COUNTS = {};

function triggerPath() {
  return process.env.SEED_RESTART_TRIGGER || path.join(__dirname, '..', 'restart-trigger.json');
}

function sendError(res, err) {
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

module.exports = function seedExportRoutes(pool, { processStartedAt } = {}) {
  const router = express.Router();
  router.use(requireAdmin(pool));

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
      const base = { id: g.id, label: g.label, lastExport: last.export || null, lastSeed: last.seed || null };
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
    res.json(await exportGroup(pool, req.params.id));
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
    res.json(await applySeed(pool, req.params.id, decisions, { signature }));
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
