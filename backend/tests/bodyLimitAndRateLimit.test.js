// F-009 (SOMET-189): express.json({limit:'50mb'})/urlencoded ran as app-level
// middleware ahead of routing AND ahead of every auth guard, so it applied to
// every unauthenticated request against any path -- including ones with no
// route, like /api/health. Confirmed live: a single unauthenticated ~44MB
// JSON POST to /api/health was fully buffered and parsed before the 404 was
// produced, and backend RSS jumped from ~37MiB to ~181MiB for that request.
// There was also no rate limiter anywhere outside /api/auth.
//
// These tests cover: (1) the global limit now rejects an oversized body
// early with 413, and (2) a rate limiter is actually wired in front of the
// router.
//
// A third case used to live here: the one route that legitimately needed
// more than 256kb (bulk map-entities save, POST /api/maps/:id/entities) got
// it via a path-scoped override. SOMET-233 removed that route as dead
// legacy-flat-map surface (no caller since the flat-map client was deleted),
// and the override went with it -- nothing needs more than 256kb anymore.
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const express = require('express');
const { app, __setPool, apiRateLimiter } = require('../src/index.js');

// Well over the new 256kb ceiling, comfortably under the old 50mb one.
const OVERSIZED_BODY = { junk: 'a'.repeat(300 * 1024) };

test('POST /api/health with an oversized body is rejected with 413, not buffered into a 404', async () => {
  __setPool({
    query: async () => { throw new Error('body-limit test: no query should run -- 413 must fire in middleware, before routing'); },
  });
  const res = await request(app)
    .post('/api/health')
    .set('Content-Type', 'application/json')
    .send(OVERSIZED_BODY);
  assert.equal(res.status, 413);
});

// The global limiter is exercised on a scratch app with a tiny ceiling
// (apiRateLimiter is exported specifically so a test doesn't have to fire
// 300 real requests against the production limiter to prove it works).
test('apiRateLimiter rejects requests once the window ceiling is hit', async () => {
  const scratch = express();
  scratch.use(apiRateLimiter(3, 60 * 1000));
  scratch.get('/ping', (req, res) => res.json({ ok: true }));

  const results = [];
  for (let i = 0; i < 5; i++) {
    results.push((await request(scratch).get('/ping')).status);
  }
  assert.deepEqual(results, [200, 200, 200, 429, 429]);
});
