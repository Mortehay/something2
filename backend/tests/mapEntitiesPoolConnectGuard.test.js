// Regression test for F-001 (SOMET-165): POST /api/maps/:id/entities and
// POST /api/maps/:id/generate-entities must survive a pool.connect() failure
// (Postgres restart, pool exhaustion) instead of taking the whole process
// down with it.
//
// Express 4.18 does not attach a .catch to an async route handler's returned
// promise. The old code called `const client = await pool.connect()` BEFORE
// entering the route's try block, so a rejection there threw out of the
// handler entirely, past every try/catch, as an unhandled promise rejection.
// With no unhandledRejection listener installed (none is installed here —
// this file requires ../src/index.js as a module, not as `require.main`, so
// the process-level backstop added alongside this fix in index.js never
// attaches), Node's default behavior is to exit the process. Because the WS
// authority (authority/server.js) is attached to the SAME http server
// (index.js:~1406), that exit takes every connected player with it.
//
// This was reproduced against the LIVE unfixed code: on the unfixed handler,
// the async function's rejection escapes past every try/catch as an
// unhandled rejection BEFORE res.status/res.json is ever called, so
// supertest's request never resolves — the request just hangs forever
// waiting for a response that will never come. (Node's test runner
// additionally captures the unhandled rejection itself and attributes it to
// the in-flight test, but that alone does not unblock the still-pending
// HTTP request.) The `withTimeout` wrapper below turns that hang into a fast,
// legible assertion failure instead of an indefinite stall.
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { adminToken, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');
const { app, __setPool } = require('../src/index.js');

const AUTH = ['Authorization', `Bearer ${adminToken()}`];

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label}: no HTTP response within ${ms}ms — the handler hung instead of responding (unguarded pool.connect() rejection escaping past res.json)`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// A pool whose connect() always rejects — the exact probe shape the finding
// names (F-001: "inject a pool whose connect() rejects"). query() still
// answers the admin-guard's token_version lookup so the request reaches the
// route handler rather than failing auth first.
function rejectingConnectPool() {
  return {
    query: async (sql) => {
      if (isUserLookup(sql)) return ADMIN_USER_ROW;
      throw new Error('mapEntitiesPoolConnectGuard: unexpected query() on a connect-rejecting pool');
    },
    connect: async () => {
      throw new Error('simulated: pool exhausted / DB connection refused');
    },
  };
}

// A normal working pool+client, used after the failure case to prove the
// server is still alive and routable end-to-end.
function workingClient() {
  return {
    query: async (sql) => {
      if (/SELECT id FROM maps WHERE id/i.test(sql)) return { rows: [{ id: 1 }] };
      if (/SELECT data FROM maps WHERE id/i.test(sql)) return { rows: [{ data: [['grass', 'grass'], ['grass', 'grass']] }] };
      if (/SELECT id, name FROM entity_types/i.test(sql)) return { rows: [] };
      if (/SELECT \* FROM entity_types/i.test(sql)) return { rows: [] };
      return { rows: [] }; // BEGIN / DELETE / COMMIT / UPDATE maps
    },
    release: () => {},
  };
}
function workingPool() {
  return {
    query: async (sql) => {
      if (isUserLookup(sql)) return ADMIN_USER_ROW;
      return { rows: [] };
    },
    connect: async () => workingClient(),
  };
}

test('POST /api/maps/:id/entities: a rejecting pool.connect() yields a 5xx, not a dead process', async () => {
  __setPool(rejectingConnectPool());

  const res = await withTimeout(
    request(app).post('/api/maps/1/entities').set(...AUTH).send({ entities: [] }),
    3000,
    'POST /api/maps/:id/entities'
  );

  assert.ok(res.status >= 500 && res.status < 600, `expected a 5xx response, got ${res.status}`);

  // Process survived: the app is still routable for a normal request right
  // after.
  __setPool(workingPool());
  const res2 = await request(app)
    .post('/api/maps/1/entities')
    .set(...AUTH)
    .send({ entities: [] });
  assert.equal(res2.status, 200);
  assert.equal(res2.body.success, true);
});

test('POST /api/maps/:id/generate-entities: a rejecting pool.connect() yields a 5xx, not a dead process', async () => {
  __setPool(rejectingConnectPool());

  const res = await withTimeout(
    request(app).post('/api/maps/1/generate-entities').set(...AUTH).send({}),
    3000,
    'POST /api/maps/:id/generate-entities'
  );

  assert.ok(res.status >= 500 && res.status < 600, `expected a 5xx response, got ${res.status}`);

  // Same liveness proof as above, for the second route sharing the bug.
  __setPool(workingPool());
  const res2 = await request(app)
    .post('/api/maps/1/generate-entities')
    .set(...AUTH)
    .send({});
  assert.equal(res2.status, 200);
  assert.equal(res2.body.success, true);
});
