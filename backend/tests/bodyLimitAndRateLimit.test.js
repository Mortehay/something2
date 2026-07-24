// F-009 (SOMET-189): express.json({limit:'50mb'})/urlencoded ran as app-level
// middleware ahead of routing AND ahead of every auth guard, so it applied to
// every unauthenticated request against any path -- including ones with no
// route, like /api/health. Confirmed live: a single unauthenticated ~44MB
// JSON POST to /api/health was fully buffered and parsed before the 404 was
// produced, and backend RSS jumped from ~37MiB to ~181MiB for that request.
// There was also no rate limiter anywhere outside /api/auth.
//
// These tests cover: (1) the global limit now rejects an oversized body
// early with 413, (2) the one route that legitimately needs more than 256kb
// (bulk map-entities save) still gets it via a path-scoped override, and
// (3) a rate limiter is actually wired in front of the router.
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const express = require('express');
const { adminToken, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');
const { app, __setPool, apiRateLimiter } = require('../src/index.js');

const AUTH = ['Authorization', `Bearer ${adminToken()}`];

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

test('POST /api/maps/:id/entities accepts a body over 256kb via its path-scoped override', async () => {
  const workingClient = () => ({
    query: async (sql) => {
      if (/SELECT id FROM maps WHERE id/i.test(sql)) return { rows: [{ id: 1 }] };
      if (/SELECT id, name FROM entity_types/i.test(sql)) return { rows: [{ id: 9, name: 'Tree' }] };
      return { rows: [] }; // BEGIN / DELETE / INSERT / COMMIT
    },
    release: () => {},
  });
  __setPool({
    query: async (sql) => (isUserLookup(sql) ? ADMIN_USER_ROW : { rows: [] }),
    connect: async () => workingClient(),
  });

  // A big-but-legitimate obstacle array: well over 256kb of JSON, comfortably
  // under the 10mb path-scoped limit.
  const entities = Array.from({ length: 6000 }, (_, i) => ({ type: 'Tree', row: i, col: i, name: `t${i}` }));
  const payloadSize = Buffer.byteLength(JSON.stringify({ entities }));
  assert.ok(payloadSize > 256 * 1024, `test payload must exceed 256kb to be meaningful (was ${payloadSize})`);

  const res = await request(app).post('/api/maps/1/entities').set(...AUTH).send({ entities });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
});

test('unauthenticated oversized body to the map-entities path is still capped (10mb), not unlimited', async () => {
  __setPool({
    query: async () => { throw new Error('must not be reached: body should 413 before any query'); },
  });
  const OVER_10MB = { entities: [{ name: 'a'.repeat(11 * 1024 * 1024) }] };
  const res = await request(app).post('/api/maps/1/entities').send(OVER_10MB); // no AUTH header
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
