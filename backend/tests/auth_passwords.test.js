const test = require('node:test');
const assert = require('node:assert');
const { hashPassword, verifyPassword } = require('../src/auth/passwords.js');

test('a hash verifies its own password and rejects a wrong one', async () => {
  const h = await hashPassword('correct horse');
  assert.equal(await verifyPassword('correct horse', h), true);
  assert.equal(await verifyPassword('wrong', h), false);
});

test('the hash is not the plaintext and differs per call (salt)', async () => {
  const a = await hashPassword('x');
  const b = await hashPassword('x');
  assert.notEqual(a, 'x');
  assert.notEqual(a, b);
  // Both still verify against the same plaintext despite differing hashes.
  assert.equal(await verifyPassword('x', a), true);
  assert.equal(await verifyPassword('x', b), true);
});

test('hashPassword uses bcrypt cost factor 12', async () => {
  const h = await hashPassword('anything');
  // bcrypt hash format: $2a$12$... — the cost factor is the two digits after the algorithm tag.
  const cost = h.split('$')[2];
  assert.equal(cost, '12');
});
