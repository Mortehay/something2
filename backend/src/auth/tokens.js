const jwt = require('jsonwebtoken');
const { smtpConfigured } = require('../email/mailer.js');

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

// Email verification gate switch. On only when real SMTP is configured (so a
// deploy without the Gmail settings locks nobody out) or a test forces it.
// Read per call, never cached: an operator restart with new env (and a test
// toggling the flag) gets the value actually configured.
function emailGateActive(env = process.env) {
  return smtpConfigured(env) || env.EMAIL_GATE_FORCE === '1';
}

// The ONE gate predicate both transports use. `emailVerified` is only present
// when the gate was active for this lookup, so an inactive gate never gates.
function isEmailGated(user) {
  return user.emailVerified === false;
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
//
// Gate INACTIVE: runs today's exact query (several test fake pools match its
// text) and returns { id, username, role }, unchanged. Gate ACTIVE: also reads
// email_verified_at and adds `emailVerified`. Whether the account is allowed
// through is decided by the caller with isEmailGated, because the HTTP side
// has an allowlist (/me, logout-all, set-email, resend) and the WS side has none.
async function currentUserForToken(pool, payload) {
  const gate = emailGateActive();
  const sql = gate
    ? 'SELECT token_version, role, email_verified_at FROM users WHERE id = $1'
    : 'SELECT token_version, role FROM users WHERE id = $1';
  const { rows } = await pool.query(sql, [payload.user_id]);
  const row = rows[0];
  if (!row || row.token_version !== payload.tv) return null;
  const user = { id: payload.user_id, username: payload.username, role: row.role };
  if (gate) user.emailVerified = row.email_verified_at != null;
  return user;
}

module.exports = { signToken, verifyToken, currentUserForToken, emailGateActive, isEmailGated };
