import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  parseJwt,
  isTokenExpired,
  storeToken,
  getStoredToken,
  clearToken,
} from "./EngineClient.js";

// A minimal in-memory localStorage stand-in — the vitest env is `node`, which
// has no localStorage. The helpers read globalThis.localStorage.
function fakeLocalStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map,
  };
}

// Build an unsigned JWT (header.payload.signature) with the given claims. The
// helpers only decode the payload — they never verify the signature (that is
// the server's job) — so a fake signature is fine here.
function makeJwt(claims) {
  const b64url = (obj) =>
    Buffer.from(JSON.stringify(obj)).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(claims)}.sig`;
}

const HOUR = 3600;
const NOW = 1_000_000; // fixed clock in seconds

describe("token helpers", () => {
  beforeEach(() => {
    globalThis.localStorage = fakeLocalStorage();
    clearToken(); // reset the module-level in-memory token between tests
  });
  afterEach(() => {
    clearToken();
    delete globalThis.localStorage;
  });

  it("parseJwt decodes the payload claims; returns null on garbage", () => {
    const t = makeJwt({ user_id: 42, tv: 1, exp: NOW + HOUR });
    expect(parseJwt(t)).toMatchObject({ user_id: 42, tv: 1 });
    expect(parseJwt("not-a-jwt")).toBeNull();
    expect(parseJwt(null)).toBeNull();
  });

  it("isTokenExpired: false for a future exp, true for a past or missing exp", () => {
    expect(isTokenExpired(makeJwt({ exp: NOW + HOUR }), NOW)).toBe(false);
    expect(isTokenExpired(makeJwt({ exp: NOW - 1 }), NOW)).toBe(true);
    expect(isTokenExpired(makeJwt({ user_id: 1 }), NOW)).toBe(true); // no exp
  });

  it("a stored valid token is returned", () => {
    const t = makeJwt({ user_id: 7, exp: NOW + HOUR });
    storeToken(t);
    expect(getStoredToken(NOW)).toBe(t);
    // And it actually persisted to localStorage (the reload path).
    expect(globalThis.localStorage.getItem("something2.authToken")).toBe(t);
  });

  it("an expired stored token is ignored AND cleared", () => {
    const expired = makeJwt({ user_id: 7, exp: NOW - 1 });
    storeToken(expired);
    expect(getStoredToken(NOW)).toBeNull();
    // Cleared as a side effect: a reload must not keep retrying a dead token.
    expect(globalThis.localStorage.getItem("something2.authToken")).toBeNull();
  });

  it("clearToken removes the token from storage and memory", () => {
    storeToken(makeJwt({ user_id: 7, exp: NOW + HOUR }));
    clearToken();
    expect(getStoredToken(NOW)).toBeNull();
    expect(globalThis.localStorage.getItem("something2.authToken")).toBeNull();
  });

  it("getStoredToken reads a token persisted by a prior 'session' (reload)", () => {
    // Simulate a token written before this module's in-memory var was set:
    // clearToken() above emptied memory, but localStorage still holds it.
    const t = makeJwt({ user_id: 9, exp: NOW + HOUR });
    globalThis.localStorage.setItem("something2.authToken", t);
    expect(getStoredToken(NOW)).toBe(t);
  });
});
