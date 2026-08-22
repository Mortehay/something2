// SOMET-437: both rate limiters keyed on `req.ip`, and `trust proxy` was never
// set. Behind the production stack (cloudflared -> caddy:80 -> backend:3101)
// req.ip is the Caddy container's address for EVERY request, so the 300/min
// global ceiling and the 10-per-15-min auth ceiling were shared by the whole
// playerbase instead of being per-player.
//
// The fix is not "trust proxy = true": that makes Express believe the
// left-most X-Forwarded-For entry, which any client can forge, turning a
// shared bucket into a limiter anyone can bypass by rotating a header. These
// tests pin the three properties that matter:
//   1. nothing configured  -> headers are ignored entirely (today's behaviour,
//      spoof-proof for a directly-exposed deployment),
//   2. TRUST_PROXY=true    -> refused at startup rather than silently accepted,
//   3. CF-Connecting-IP    -> honoured only when explicitly enabled AND a
//      trusted-hop count is configured, and it outranks X-Forwarded-For.
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { applyTrustProxy, clientIp, clientIpKey, trustProxySetting } = require('../src/clientIp.js');

// A scratch app that echoes what the limiters would key on, so a test can read
// the decision directly instead of inferring it from 429s.
function echoApp(env) {
  const app = express();
  applyTrustProxy(app, env);
  app.get('/who', (req, res) => res.json({ ip: clientIp(req, env), key: clientIpKey(req, env) }));
  return app;
}

test('with nothing configured, forged proxy headers cannot shift the bucket', async () => {
  const app = echoApp({});
  const a = await request(app).get('/who').set('X-Forwarded-For', '203.0.113.7');
  const b = await request(app).get('/who').set('X-Forwarded-For', '198.51.100.9')
    .set('CF-Connecting-IP', '198.51.100.9');
  assert.equal(a.body.key, b.body.key, 'a client that rotates headers must stay in one bucket');
});

test('TRUST_PROXY=true is refused rather than silently trusting the left-most XFF entry', () => {
  assert.throws(() => trustProxySetting({ TRUST_PROXY: 'true' }), /TRUST_PROXY/);
  assert.equal(trustProxySetting({}), false);
  assert.equal(trustProxySetting({ TRUST_PROXY: '2' }), 2);
  assert.equal(trustProxySetting({ TRUST_PROXY: 'loopback' }), 'loopback');
});

test('with a hop count configured, X-Forwarded-For separates two real clients', async () => {
  const app = echoApp({ TRUST_PROXY: '1' });
  const a = await request(app).get('/who').set('X-Forwarded-For', '203.0.113.7');
  const b = await request(app).get('/who').set('X-Forwarded-For', '198.51.100.9');
  assert.equal(a.body.ip, '203.0.113.7');
  assert.notEqual(a.body.key, b.body.key);
});

test('CF-Connecting-IP outranks X-Forwarded-For when it is enabled', async () => {
  const env = { TRUST_PROXY: '2', TRUST_CF_CONNECTING_IP: '1' };
  const app = echoApp(env);
  // Cloudflare sets and OVERWRITES this header at the edge, so it is the one
  // value in the chain a client cannot choose. Same forged XFF on both, two
  // different real clients: the buckets must still separate.
  const a = await request(app).get('/who')
    .set('X-Forwarded-For', '203.0.113.7').set('CF-Connecting-IP', '192.0.2.1');
  const b = await request(app).get('/who')
    .set('X-Forwarded-For', '203.0.113.7').set('CF-Connecting-IP', '192.0.2.2');
  assert.equal(a.body.ip, '192.0.2.1');
  assert.notEqual(a.body.key, b.body.key);
});

test('the CF header is ignored unless a trusted-hop count is also configured', async () => {
  // Enabling the header alone would be a hole: with no trusted proxy in front,
  // the request reaching us IS the client, and it can send any CF header.
  const app = echoApp({ TRUST_CF_CONNECTING_IP: '1' });
  const res = await request(app).get('/who').set('CF-Connecting-IP', '192.0.2.1');
  assert.notEqual(res.body.ip, '192.0.2.1');
});

test('with the CF header absent, resolution falls back to the peer address', async () => {
  const app = echoApp({ TRUST_PROXY: '1', TRUST_CF_CONNECTING_IP: '1' });
  const res = await request(app).get('/who');
  assert.ok(res.body.key, 'a key must still be produced');
});

test('a limiter keyed this way gives each client its own ceiling', async () => {
  const env = { TRUST_PROXY: '2', TRUST_CF_CONNECTING_IP: '1' };
  const scratch = express();
  applyTrustProxy(scratch, env);
  scratch.use(rateLimit({
    windowMs: 60 * 1000,
    limit: 2,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => clientIpKey(req, env),
  }));
  scratch.get('/ping', (req, res) => res.json({ ok: true }));

  const hit = (ip) => request(scratch).get('/ping').set('CF-Connecting-IP', ip);
  assert.deepEqual(
    [(await hit('192.0.2.1')).status, (await hit('192.0.2.1')).status, (await hit('192.0.2.1')).status],
    [200, 200, 429],
  );
  // A second player must NOT inherit the first player's exhausted bucket.
  assert.equal((await hit('192.0.2.2')).status, 200);
});
