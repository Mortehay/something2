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

// Whether a /api/auth/me probe response means "this session is dead".
// ONLY a literal 401 does. A network error or a 5xx must NOT sign the user out --
// a flaky backend would otherwise log everyone out. Extracted from the provider
// so this rule is testable in the node vitest env.
export function shouldSignOutOnProbe(status) {
  return status === 401;
}

// Whether a /me body is an actual answer. A 200 whose body is not the /me JSON (a proxy's HTML page, which reads as
// `{}`) carries no `emailRequired`; treating it as an answer would silently switch the gate off, so it is a failed
// probe instead (and the gate fails open on that, by the existing ruling, but stays retryable).
export function isMeAnswer(me) {
  return !!me && typeof me === "object" && typeof me.emailRequired === "boolean";
}
