// Shared auth test helper.
//
// Sets a deterministic JWT_SECRET (before any token is signed/verified) and
// provides an admin identity plus a pool wrapper that answers the auth
// middleware's user lookup. Import this FIRST in a test file — ahead of
// requiring ../src/index.js — so the secret is in place before the guards run.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-deterministic';

const { signToken } = require('../../src/auth/tokens.js');

const ADMIN_ID = 1;
const ADMIN_TOKEN_VERSION = 1;

// A signed, current-version admin token the protected routes accept.
function adminToken() {
  return signToken({
    userId: ADMIN_ID,
    username: 'admin',
    role: 'admin',
    tokenVersion: ADMIN_TOKEN_VERSION,
  });
}

// Header object for supertest .set(...).
function authHeaders() {
  return { Authorization: `Bearer ${adminToken()}` };
}

// The middleware runs: SELECT token_version, role FROM users WHERE id = $1
function isUserLookup(sql) {
  return /FROM users/i.test(sql) && /token_version/i.test(sql);
}

const ADMIN_USER_ROW = { rows: [{ token_version: ADMIN_TOKEN_VERSION, role: 'admin' }] };

// Wrap a plain query(sql, params) fn so the guard's user lookup is answered with
// a current-version admin row; every other query falls through to `queryFn`.
function withAuth(queryFn) {
  return async (sql, params) => {
    if (isUserLookup(sql)) return ADMIN_USER_ROW;
    return queryFn(sql, params);
  };
}

module.exports = {
  ADMIN_ID,
  ADMIN_TOKEN_VERSION,
  adminToken,
  authHeaders,
  isUserLookup,
  ADMIN_USER_ROW,
  withAuth,
};
