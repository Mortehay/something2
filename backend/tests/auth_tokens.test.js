process.env.JWT_SECRET = 'test-secret';

const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');
const { signToken, verifyToken } = require('../src/auth/tokens.js');

test('a signed token round-trips its claims including token_version', () => {
  const t = signToken({ userId: 7, username: 'bob', role: 'player', tokenVersion: 3 });
  const p = verifyToken(t);
  assert.ok(p);
  assert.equal(p.user_id, 7);
  assert.equal(p.username, 'bob');
  assert.equal(p.role, 'player');
  assert.equal(p.tv, 3);
});

test('a tampered or wrong-secret token verifies to null, never throws', () => {
  assert.equal(verifyToken('garbage.token.here'), null);
  assert.doesNotThrow(() => verifyToken('garbage.token.here'));

  const wrongSecretToken = jwt.sign({ user_id: 1, username: 'x', role: 'player', tv: 1 }, 'a-different-secret', {
    algorithm: 'HS256',
    expiresIn: '24h',
  });
  assert.equal(verifyToken(wrongSecretToken), null);
});

test('an expired token verifies to null', () => {
  const expired = jwt.sign(
    { user_id: 1, username: 'x', role: 'player', tv: 1 },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: -10 },
  );
  assert.equal(verifyToken(expired), null);
});

test('signToken uses the same JWT_SECRET the WS authority verifies against', () => {
  const t = signToken({ userId: 1, username: 'a', role: 'player', tokenVersion: 1 });
  // The authority does jwt.verify(token, jwtSecret, { algorithms: ['HS256'] })
  // reading opts.jwtSecret, which is sourced from process.env.JWT_SECRET at boot.
  const payload = jwt.verify(t, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  assert.equal(payload.user_id, 1);
});

test('a token signed with a different secret is rejected exactly like the authority would reject it', () => {
  const foreign = jwt.sign({ user_id: 1, username: 'a', role: 'player', tv: 1 }, 'not-the-real-secret', {
    algorithm: 'HS256',
  });
  assert.throws(() => jwt.verify(foreign, process.env.JWT_SECRET, { algorithms: ['HS256'] }));
  assert.equal(verifyToken(foreign), null);
});
