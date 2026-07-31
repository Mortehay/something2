import { parseJwt } from "../games/something2/src/js/net/auth.js";

// Derive the whole auth view-model from the raw JWT. Deliberately pure and
// React-free so the rule that decides who sees the admin nav can be unit-tested
// in the plain node vitest env, which has no DOM.
//
// A malformed or absent token yields the signed-out shape rather than throwing.
// getStoredToken() already drops expired and unparseable tokens, so anything
// that reaches here and fails to parse is treated as "not signed in".
export function deriveAuth(token) {
  const claims = token ? parseJwt(token) : null;
  return {
    authed: !!claims,
    isAdmin: claims?.role === "admin",
    username: claims?.username ?? null,
  };
}
