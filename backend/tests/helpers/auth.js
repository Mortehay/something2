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

// A non-admin identity (SOMET-559). Routes behind playerGuard must accept this;
// routes behind adminGuard must reject it with 403. Without a second identity a
// test suite cannot tell the two guards apart -- both merely "require a token" --
// and swapping one for the other stays green while breaking the game for every
// non-admin player.
const PLAYER_ID = 2;
const PLAYER_TOKEN_VERSION = 1;

function playerToken() {
  return signToken({
    userId: PLAYER_ID,
    username: 'player',
    role: 'player',
    tokenVersion: PLAYER_TOKEN_VERSION,
  });
}

// The middleware runs: SELECT token_version, role FROM users WHERE id = $1
function isUserLookup(sql) {
  return /FROM users/i.test(sql) && /token_version/i.test(sql);
}

const ADMIN_USER_ROW = { rows: [{ token_version: ADMIN_TOKEN_VERSION, role: 'admin' }] };
const PLAYER_USER_ROW = { rows: [{ token_version: PLAYER_TOKEN_VERSION, role: 'player' }] };

// Answer the guard's lookup with whichever identity the token claims, keyed on
// the id the middleware passes as $1. A fixture that always returns the admin
// row would make a player token silently authenticate AS an admin, which would
// turn a 403 test into a false pass.
function userRowFor(params) {
  const id = Array.isArray(params) ? params[0] : undefined;
  return Number(id) === PLAYER_ID ? PLAYER_USER_ROW : ADMIN_USER_ROW;
}

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
  PLAYER_ID,
  PLAYER_TOKEN_VERSION,
  playerToken,
  PLAYER_USER_ROW,
  userRowFor,
};
