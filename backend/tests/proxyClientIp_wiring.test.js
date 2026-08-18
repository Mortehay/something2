// SOMET-437 -- the wiring half. clientIp.test.js proves the resolver behaves;
// this proves the live app actually USES it, which is the half that would
// otherwise rot silently: every assertion here would still pass on a resolver
// that nothing imports.
//
// Env is set before requiring src/index.js because applyTrustProxy(app) runs
// at import time, exactly as it does at boot. node --test gives each file its
// own process, so this does not leak into any other suite.
process.env.TRUST_PROXY = '2';
process.env.TRUST_CF_CONNECTING_IP = '1';

const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const express = require('express');
const { app, apiRateLimiter } = require('../src/index.js');
const authRouter = require('../src/auth/routes.js');

test('the app trusts exactly the configured hop count, never blanket-true', () => {
  assert.equal(app.get('trust proxy'), 2);
});

test('the global limiter separates two clients arriving through the same proxy', async () => {
  const scratch = express();
  scratch.set('trust proxy', 2);
  scratch.use(apiRateLimiter(2, 60 * 1000));
  scratch.get('/ping', (req, res) => res.json({ ok: true }));

  const hit = (ip) => request(scratch).get('/ping')
    // Identical XFF on every request: this is what the proxy chain looks like
    // to the backend. Only CF-Connecting-IP tells the two players apart.
    .set('X-Forwarded-For', '203.0.113.7, 10.0.0.2').set('CF-Connecting-IP', ip);

  assert.deepEqual(
    [(await hit('192.0.2.1')).status, (await hit('192.0.2.1')).status, (await hit('192.0.2.1')).status],
    [200, 200, 429],
  );
  assert.equal((await hit('192.0.2.2')).status, 200, 'a second player inherited the first one\'s bucket');
});

test('the auth limiter no longer locks one household out because of another', async () => {
  // 10 failed logins per 15 minutes, keyed IP+username. Before this fix every
  // player behind the proxy shared the IP half, so ten bad attempts anywhere
  // could exhaust the bucket a legitimate player needed.
  const scratch = express();
  scratch.set('trust proxy', 2);
  scratch.use(express.json());
  scratch.use('/api/auth', authRouter({
    query: async () => ({ rows: [] }), // no such user -> 401, which still consumes a slot
  }));

  const attempt = (ip) => request(scratch).post('/api/auth/login')
    .set('CF-Connecting-IP', ip)
    .send({ username: 'shared-name', password: 'wrong' });

  const first = [];
  for (let i = 0; i < 11; i++) first.push((await attempt('192.0.2.10')).status);
  assert.equal(first.at(-1), 429, 'the eleventh attempt from one client must be refused');

  const other = await attempt('192.0.2.11');
  assert.notEqual(other.status, 429, 'a different client must not inherit that exhausted bucket');
});
