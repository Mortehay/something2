const jwt = require('jsonwebtoken');

// MUST be the same secret the WS authority verifies against
// (backend/src/authority/server.js: jwt.verify(token, jwtSecret, { algorithms: ['HS256'] })),
// which is sourced from process.env.JWT_SECRET at boot.
function secret() {
  return process.env.JWT_SECRET;
}

function signToken({ userId, username, role, tokenVersion }) {
  return jwt.sign(
    { user_id: userId, username, role, tv: tokenVersion },
    secret(),
    { algorithm: 'HS256', expiresIn: '24h' },
  );
}

// Returns the decoded payload, or null on ANY failure (bad signature, expired,
// malformed) — never throws. Callers branch on null.
function verifyToken(token) {
  try {
    return jwt.verify(token, secret(), { algorithms: ['HS256'] });
  } catch (err) {
    return null;
  }
}

module.exports = { signToken, verifyToken };
