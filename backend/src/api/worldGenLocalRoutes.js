// SOMET-644 Task 6. Admin API for the local world-generator fallback
// (services/worldGenLocal.js), mounted at /api/world-gen/local beside the box
// routes. Both routes are admin-only, like every /api/world-gen route.
//
//   POST /preview  body: the box create's body -> 200 { name, params, author,
//                  spec, report, valid, errors, ignored, note }
//   POST /save     body: { name, params, overwrite? } -> 201 { name, file,
//                  overwrote, worlds, author, ignored, note, next }
//
// Errors: 400 bad_params, 409 exists / synced / authored / manifest_unreadable,
// 422 invalid_spec (+ errors), 500.
const express = require('express');
const { requireAdmin } = require('../auth/middleware.js');
const local = require('../services/worldGenLocal.js');
const { mapSpecCatalogs } = require('../services/mapSpecCatalogs.js');

function sendError(res, err, fallback) {
  if (err && err.name === 'WorldGenError') {
    const body = { error: err.message, code: err.code };
    if (err.errors) body.errors = err.errors;
    return res.status(err.status).json(body);
  }
  console.error(err);
  return res.status(500).json({ error: fallback });
}

module.exports = function worldGenLocalRoutes(pool) {
  const router = express.Router();
  router.use(requireAdmin(pool));

  router.post('/preview', async (req, res) => {
    try {
      // Parse first: a bad body is a 400 without a DB round trip.
      local.parseLocalParams(req.body);
      res.json(local.preview(req.body, await mapSpecCatalogs(pool)));
    } catch (err) {
      sendError(res, err, 'Failed to generate the region locally');
    }
  });

  router.post('/save', async (req, res) => {
    try {
      if (req.body && typeof req.body === 'object') local.parseLocalParams(req.body.params);
      res.status(201).json(local.save(req.body, await mapSpecCatalogs(pool)));
    } catch (err) {
      sendError(res, err, 'Failed to save the locally generated region');
    }
  });

  return router;
};
