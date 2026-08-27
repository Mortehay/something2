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

// The asset burst that broke the game (see the ASSET_PATH_PREFIX block in
// src/index.js): joining a world preloads one image per sprited entity type --
// 194 against the live catalog -- and every one of them was spending the same
// 300/min API budget as the calls that keep the HUD alive. Live, the burst
// tripped the limiter and the following /api/worlds/:id/overview and
// /api/player/waypoints calls came back 429.
//
// Asserted against the REAL `app`, not a scratch one, because what broke was
// the WIRING (order + skip), not the limiter factory. A scratch app would keep
// passing with the fix reverted.
//
// Deltas, not absolute counts: `app`'s limiter carries state from whatever
// else ran in this process first, so the test reads the remaining budget
// before and after rather than assuming it starts full.
test('/api/assets is not charged to the API rate-limit budget', async () => {
  __setPool({ query: async () => ({ rows: [] }) });
  const remaining = async () => {
    const res = await request(app).get('/api/health');
    return Number(res.headers['ratelimit-remaining']);
  };

  const before = await remaining();
  for (let i = 0; i < 5; i++) {
    // 404s here (no object store in the unit env), which is fine: the limiter
    // is app-level middleware and runs long before the route does.
    const res = await request(app).get('/api/assets/sprites/Nope/seeded/static.png');
    assert.equal(
      res.headers['ratelimit-limit'], '1200',
      'assets should answer under their own high ceiling, not the 300/min API one',
    );
  }
  const after = await remaining();

  // Exactly 1: the second /api/health probe itself. If the five asset requests
  // were still counted, this would be 6.
  assert.equal(before - after, 1);
});
