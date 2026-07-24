/**
 * Auth: register / login against /api/auth, plus JWT token storage helpers.
 *
 * Split out of net/EngineClient.js (F-030/SOMET-210): that file used to also
 * hold a WebSocket-wrapper `EngineClient` class for the pre-chunked-world
 * engine, which is now unreachable (Something2.jsx only ever talks to the
 * world authority via WorldAuthorityClient) and was deleted along with it.
 * These functions are deliberately pure (no DOM) so they can be unit-tested
 * in the node vitest env; the login FORM itself is verified by the build +
 * browser pass.
 */

const TOKEN_KEY = "something2.authToken";

// In-memory copy so a running session doesn't re-read localStorage on every
// use, and so the token survives even where localStorage is unavailable
// (private-mode quotas, etc.). localStorage is the source of truth ACROSS a
// reload; memory is the fast path within a session.
let memoryToken = null;

function storage() {
  try {
    return typeof globalThis !== "undefined" && globalThis.localStorage
      ? globalThis.localStorage
      : null;
  } catch {
    // Accessing localStorage can throw (sandboxed iframes, disabled storage).
    return null;
  }
}

function b64urlDecode(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  if (typeof atob === "function") return atob(b64);
  // Node (vitest) fallback.
  return Buffer.from(b64, "base64").toString("binary");
}

// Decode a JWT's payload without verifying the signature (verification is the
// server's job). Returns the claims object, or null if the token is malformed.
export function parseJwt(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(b64urlDecode(parts[1]));
  } catch {
    return null;
  }
}

// A token is expired if it has no numeric `exp`, or `exp` is at/behind now.
// nowSec is injectable so tests don't depend on the wall clock.
export function isTokenExpired(token, nowSec = Date.now() / 1000) {
  const payload = parseJwt(token);
  if (!payload || typeof payload.exp !== "number") return true;
  return payload.exp <= nowSec;
}

export function storeToken(token) {
  memoryToken = token || null;
  const s = storage();
  if (s && token) {
    try { s.setItem(TOKEN_KEY, token); } catch { /* storage full/blocked: memory still holds it */ }
  }
}

export function clearToken() {
  memoryToken = null;
  const s = storage();
  if (s) {
    try { s.removeItem(TOKEN_KEY); } catch { /* best-effort */ }
  }
}

// Returns a stored token that still parses as unexpired, or null. An expired
// (or malformed) token is CLEARED as a side effect so a reload doesn't keep
// retrying a dead token. This is the SOMET-97 fix: a valid token survives the
// reload instead of minting a brand-new identity.
export function getStoredToken(nowSec = Date.now() / 1000) {
  const s = storage();
  let stored = memoryToken;
  if (!stored && s) {
    try { stored = s.getItem(TOKEN_KEY); } catch { stored = null; }
  }
  if (!stored) return null;
  if (isTokenExpired(stored, nowSec)) {
    clearToken();
    return null;
  }
  memoryToken = stored;
  return stored;
}

// Standard headers for an /api request. Attaches the stored JWT as a Bearer
// token when one is present so admin mutations (POST/PUT/DELETE) authenticate;
// omits Authorization when signed out. Every mutating fetch in the data hooks
// funnels through this one helper so the token wiring can't drift per-call-site.
export function authHeaders() {
  const token = getStoredToken();
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

// Event the UI listens for to drop back to the sign-in screen.
export const AUTH_EXPIRED_EVENT = "something2:auth-expired";

// A 401 on a request we DID send a token with means that token is dead —
// expired, or revoked by a token_version bump (logout-everywhere, an admin
// password rotation). getStoredToken() cannot detect revocation: the JWT still
// parses and is unexpired, so the app keeps believing it is signed in while
// every write 401s. That looks like a broken app, not a dead session.
//
// Clearing at the point of failure is what makes this reliable — a check that
// only runs at mount misses a session revoked while the tab is open.
export function noteAuthFailure(res) {
  if (!res || res.status !== 401) return res;
  if (!getStoredToken()) return res;   // already signed out; nothing to clear
  clearToken();
  try {
    globalThis.dispatchEvent?.(new CustomEvent(AUTH_EXPIRED_EVENT));
  } catch { /* no DOM (tests/SSR): clearing the token is the part that matters */ }
  return res;
}

// fetch() + automatic dead-token handling. The data hooks call this instead of
// bare fetch so no call site can forget the 401 check.
export async function apiFetch(url, options) {
  return noteAuthFailure(await fetch(url, options));
}

async function postAuth(apiUrl, path, username, password) {
  const res = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data; // { token, user }
}

// Both return { token, user }. Callers store the token via storeToken().
export function register(apiUrl, username, password) {
  return postAuth(apiUrl, "/api/auth/register", username, password);
}
export function login(apiUrl, username, password) {
  return postAuth(apiUrl, "/api/auth/login", username, password);
}
