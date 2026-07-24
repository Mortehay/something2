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

// The revocation check: a signature-valid token is not enough — its `tv`
// must still match the account's CURRENT token_version, or logout-all /
// bans would only affect future HTTP requests and never touch an
// already-open WS game socket. This used to be two independent copies (one
// in auth/middleware.js's HTTP guard, one in authority/server.js's WS
// upgrade handler) with no test asserting they agreed (F-021 / SOMET-201).
// They read different column lists (the HTTP copy also needed `role`) and
// had already diverged that far with nothing forcing them back in sync —
// a second revocation condition (a ban flag, an issued-at floor) added to
// only one copy would leave the other transport silently unprotected.
//
// Selects `role` unconditionally (not just for the HTTP caller that uses
// it) so there is exactly ONE query both callers run — the WS caller
// simply ignores the extra column. Returns the row payload callers need
// (`{ id, username, role }`) when the token is still current, or `null`
// when it's missing or revoked. Throws on a DB error; each call site
// decides its own transport-specific response to that (500 JSON vs
// destroying the socket) — this function only owns the shared check.
async function currentUserForToken(pool, payload) {
  const { rows } = await pool.query('SELECT token_version, role FROM users WHERE id = $1', [payload.user_id]);
  const row = rows[0];
  if (!row || row.token_version !== payload.tv) return null;
  return { id: payload.user_id, username: payload.username, role: row.role };
}

module.exports = { signToken, verifyToken, currentUserForToken };
