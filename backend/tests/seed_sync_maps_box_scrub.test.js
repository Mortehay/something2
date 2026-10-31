'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { scrub } = require('../src/services/seedSync/mapsBoxPush');

test('scrub removes the known token and a token-shaped Bearer value', () => {
  assert.strictEqual(scrub('x sx-secret-token-123 y', 'sx-secret-token-123'), 'x [token] y');
  assert.strictEqual(scrub('Authorization: Bearer abc123def456', null), 'Authorization: [token]');
  assert.strictEqual(scrub('bearer QWERTYUIOPASDFGHJKLZXCVB', null), '[token]');
  // A short letters-only token is caught by the exact match; no "Bearer" is left.
  assert.strictEqual(scrub('Authorization: Bearer abcdefgh', 'abcdefgh'), 'Authorization: [token]');
});

test('scrub leaves the words "bearer token" in plain messages alone', () => {
  const notConfigured = 'Add one under Settings -> AI connectors with the generator host and its bearer token.';
  assert.strictEqual(scrub(notConfigured, null), notConfigured);
  const authFailed = 'The world-spec service at http://box rejected the bearer token stored on AI connector "gpu" (HTTP 401).';
  assert.strictEqual(scrub(authFailed, 'sx-secret-token-123'), authFailed);
});
