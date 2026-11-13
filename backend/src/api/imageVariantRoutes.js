// Images admin tab: list game images with their web-copy state, run batch
// shrink/undo, reactivate one, and read the operation log. Admin only.
const express = require('express');
const { requireAdmin } = require('../auth/middleware.js');
const defaultStore = require('../services/assetStore.js');
const { listImages, reactivateSubject } = require('../services/imageVariants.js');
const { imageColumns, defaultParams } = require('../services/imageCatalog.js');
const run = require('../services/imageShrinkRun.js');

const STATES = ['original', 'shrunk', 'stale', 'undone'];

function validSubject(s) {
  return s && typeof s === 'object' && ['table', 'key', 'column'].every((k) => typeof s[k] === 'string' && s[k]);
}
const pick = (s) => ({ table: s.table, key: s.key, column: s.column });

module.exports = function imageVariantRoutes(pool, { store = defaultStore } = {}) {
  const router = express.Router();
  router.use(requireAdmin(pool));

  const handler = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.error('image route failed', err && err.message);
      res.status(500).json({ error: 'image request failed' });
    }
  };

  router.get('/kinds', (req, res) => {
    const kinds = [...new Set(imageColumns().map((c) => c.kind))];
    res.json(kinds.map((kind) => ({ kind, defaults: defaultParams(kind) })));
  });

  router.get('/runs/current', (req, res) => res.json(run.getRun()));

  router.post('/runs/current/cancel', (req, res) => {
    const v = run.cancelRun();
    if (!v) return res.status(409).json({ error: 'no run in progress' });
    return res.json(v);
  });

  router.post('/runs', handler(async (req, res) => {
    const { op, subjects, params } = req.body || {};
    if (!Array.isArray(subjects) || subjects.length === 0 || !subjects.every(validSubject)) {
      return res.status(400).json({ error: 'subjects must be a non-empty list of {table, key, column}' });
    }
    if (op !== 'shrink' && op !== 'undo') return res.status(400).json({ error: 'op must be shrink or undo' });
    try {
      const view = await run.startRun(pool, store, {
        op, subjects: subjects.map(pick), params: params == null ? null : params, actor: req.user.id,
      });
      return res.status(201).json(view);
    } catch (err) {
      if (err.code === 'running') return res.status(409).json({ error: 'run in progress' });
      if (err.code === 'bad_request') return res.status(400).json({ error: err.message });
      throw err;
    }
  }));

  router.post('/reactivate', handler(async (req, res) => {
    const { subject } = req.body || {};
    if (!validSubject(subject)) return res.status(400).json({ error: 'subject must be {table, key, column}' });
    const op = await reactivateSubject(pool, store, pick(subject), { actor: req.user.id });
    if (op.status !== 'ok') return res.status(409).json({ error: op.error || 'reactivate failed', op });
    return res.json(op);
  }));

  router.get('/operations', handler(async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000);
    const batch = req.query.batch_id;
    if (batch !== undefined && !/^[0-9a-f-]{36}$/i.test(String(batch))) {
      return res.status(400).json({ error: 'bad batch_id' });
    }
    const { rows } = await pool.query(
      `SELECT * FROM image_operations WHERE ($1::uuid IS NULL OR batch_id = $1::uuid)
        ORDER BY id DESC LIMIT $2`, [batch || null, limit]);
    res.json(rows);
  }));

  router.get('/', handler(async (req, res) => {
    const { kind, state, minBytes } = req.query;
    if (state !== undefined && !STATES.includes(state)) return res.status(400).json({ error: 'bad state' });
    let min;
    if (minBytes !== undefined) {
      min = Number(minBytes);
      if (!Number.isFinite(min) || min < 0) return res.status(400).json({ error: 'bad minBytes' });
    }
    res.json(await listImages(pool, store, { kind, state, minBytes: min }));
  }));

  return router;
};
