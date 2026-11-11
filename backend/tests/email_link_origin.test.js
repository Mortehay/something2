const test = require('node:test');
const assert = require('node:assert');
const { linkOrigin } = require('../src/email/linkOrigin.js');

function req({ origin, host } = {}) {
  const h = {};
  if (origin !== undefined) h.origin = origin;
  if (host !== undefined) h.host = host;
  return { headers: h, get: (n) => h[String(n).toLowerCase()] };
}

test('allowlisted Origin is returned', () => {
  const env = { CORS_ORIGINS: 'http://localhost:15173' };
  assert.strictEqual(linkOrigin(req({ origin: 'http://localhost:15173', host: 'x' }), env), 'http://localhost:15173');
});

test('allowlist tolerates spaces, case and trailing slash', () => {
  const env = { CORS_ORIGINS: 'http://a.test , HTTP://Localhost:15173/' };
  assert.strictEqual(linkOrigin(req({ origin: 'http://localhost:15173', host: 'x' }), env), 'http://localhost:15173');
});

test('Origin equal to APP_URL is returned', () => {
  const env = { APP_URL: 'https://app.test/' };
  assert.strictEqual(linkOrigin(req({ origin: 'https://APP.test', host: 'other' }), env), 'https://app.test');
});

test('same-origin tunnel host is returned with empty CORS_ORIGINS', () => {
  const r = req({ origin: 'https://abc.trycloudflare.com', host: 'abc.trycloudflare.com' });
  assert.strictEqual(linkOrigin(r, { CORS_ORIGINS: '' }), 'https://abc.trycloudflare.com');
});

test('same-origin compares host incl. port, case-insensitively', () => {
  assert.strictEqual(linkOrigin(req({ origin: 'http://Foo.test:8080', host: 'foo.TEST:8080' }), {}), 'http://foo.test:8080');
  assert.strictEqual(linkOrigin(req({ origin: 'http://foo.test:8080', host: 'foo.test' }), {}), null);
});

test('forged Origin falls back to APP_URL', () => {
  const r = req({ origin: 'https://evil.example', host: 'abc.trycloudflare.com' });
  assert.strictEqual(linkOrigin(r, { APP_URL: 'https://app.test' }), 'https://app.test');
});

test('forged Origin falls back to first CORS_ORIGINS entry when no APP_URL', () => {
  const r = req({ origin: 'https://evil.example', host: 'abc.test' });
  assert.strictEqual(linkOrigin(r, { CORS_ORIGINS: ' http://one.test/ ,http://two.test' }), 'http://one.test');
});

test('forged Origin with nothing configured is null', () => {
  const r = req({ origin: 'https://evil.example', host: 'abc.trycloudflare.com' });
  assert.strictEqual(linkOrigin(r, { APP_URL: '', CORS_ORIGINS: '' }), null);
});

test('no Origin uses APP_URL; unparseable Origin is treated as absent', () => {
  assert.strictEqual(linkOrigin(req({ host: 'h' }), { APP_URL: 'https://app.test' }), 'https://app.test');
  assert.strictEqual(linkOrigin(req({ origin: 'not a url', host: 'not a url' }), { APP_URL: 'https://app.test' }), 'https://app.test');
  assert.strictEqual(linkOrigin(req({ origin: 'null', host: 'null' }), {}), null);
});

test('non-http(s) Origin is never trusted', () => {
  assert.strictEqual(linkOrigin(req({ origin: 'javascript://x', host: 'x' }), {}), null);
});
