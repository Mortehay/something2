const test = require('node:test');
const assert = require('node:assert');
const { normalizeEmail } = require('../src/auth/emailAddress.js');

test('normalizeEmail', () => {
  assert.equal(normalizeEmail('  Bob@Gmail.COM '), 'bob@gmail.com');
  assert.equal(normalizeEmail('a@b'), null);
  assert.equal(normalizeEmail('a b@c.com'), null);
  assert.equal(normalizeEmail(''), null);
  assert.equal(normalizeEmail(null), null);
  assert.equal(normalizeEmail({}), null);
  assert.equal(normalizeEmail(`${'a'.repeat(250)}@b.co`), null);
  assert.equal(normalizeEmail(`${'a'.repeat(245)}@b.co`)?.length, 250);
});
