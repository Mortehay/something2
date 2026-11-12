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

test('normalizeEmail refuses list, display-name, whitespace and control characters', () => {
  for (const bad of [
    'a@b.com,c@d.com', 'a@b.com;c@d.com', '<a@b.com>', 'Bob <a@b.com>', '"a"@b.com', 'a(x)@b.com', 'a)@b.com',
    'a\tb@c.com', 'a@b.com\r\nBcc: x@y.com', 'a\u0000@b.com', 'a\u007f@b.com', 'a@b\u000b.com',
  ]) assert.equal(normalizeEmail(bad), null, JSON.stringify(bad));
  // Ordinary addresses, including plus and dot forms, still pass.
  assert.equal(normalizeEmail('First.Last+tag@Example.co.uk'), 'first.last+tag@example.co.uk');
});
