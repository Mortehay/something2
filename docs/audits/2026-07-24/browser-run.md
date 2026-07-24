# Browser verification run — 2026-07-24

Driven live against the running `something2` stack via Chrome DevTools MCP
(headless Chrome on `127.0.0.1:29222`), per the `audit-browser` skill.

Preconditions checked before starting:

- Frontend `http://localhost:15173` → 200
- Backend `http://localhost:13101/api/health` → 200
- `docker ps --filter name=something2` → `something2-backend-1`,
  `something2-frontend-1`, `something2-db-1`, `something2-redis-1`, plus
  `something2-sprite-gen-1` and `something2-game-engine-1` all up.
- Pre-audit dump present: `/tmp/something2-audit/game_db-pre-audit.sql` (7.8 MB).

**Context noted before running:** `JWT_SECRET` was rotated shortly before this
run and the backend now has a boot-time guard rejecting a missing, placeholder,
or under-32-character secret. F-038 (weak JWT secret) and F-032 (sprite-gen
tests writing to the live store) are already `status: fixed` in
`findings.json` and were not re-tested as open findings — F-038's fix is,
however, exercised below as a regression check.

---

## Flow A — auth and authorization

All cases were driven either through the real UI (register/login/logout) or
via `evaluate_script` issuing `fetch`/`WebSocket` calls from the page's own
origin (`http://localhost:15173`), so cookies/headers match a real client and
CORS applies exactly as it would for a player. Test account:
`audit_flowA_user1` (created fresh through the UI register form; role reported
back as `player`).

### Positive path

| Step | Asserted | Observed | Verdict |
|---|---|---|---|
| Register via UI (`Need an account? Register` → fill → Register) | Account created, auto-authenticated, role is `player` even though nothing in the UI can request a role | `POST /api/auth/register` → `201`, decoded JWT payload `{user_id, username, role:"player", tv:1, ...}`; UI moved straight to the Worlds/game shell | Pass |
| `GET /api/auth/me` with the fresh token | `200` with `{id, username, role}` | `200`, `{"id":452,"username":"audit_flowA_user1","role":"player"}` | Pass |
| Sign out via UI button | localStorage token cleared, UI reverts to the Sign-in form | `localStorage.getItem('something2.authToken')` → `null`; snapshot showed the Sign-in form again | Pass |
| Log back in via UI (username + password, `Log in`) | Re-authenticates with the same account, returns to the Worlds shell | Succeeded, worlds list rendered again, no console errors beyond the artifacts of the negative tests run earlier in the same tab (see below) | Pass |
| `POST /api/auth/logout-all` (separately, on the role-injection test account, see below) | `200 {ok:true}`, and the token used to call it is itself invalidated afterward | `200 {"ok":true}`; same token then rejected by both `/api/auth/me` and a live WS upgrade (see negative table) | Pass |

### Negative table (skill's Flow A table)

| Attack | Expected | Observed | Verdict |
|---|---|---|---|
| Player token against an admin-only route (`POST /api/tile-types` with the player's own bearer token) | `403` | `403 {"error":"admin role required"}`, no row created | Pass — not exploitable |
| `{"role":"admin"}` in the register body (`POST /api/auth/register` with `role:"admin"` in the JSON body) | Account created as `player` | `201`, response `user.role === "player"`; server-side role literal is hardcoded to `'player'` in the INSERT, body value is ignored | Pass — not exploitable |
| JWT with the signature byte-flipped (took a real valid token, flipped one base64 char in the signature segment) | `401` | `401 {"error":"invalid token"}` | Pass — not exploitable |
| JWT with `exp` in the past (signed inside the backend container with the live `JWT_SECRET`, `exp` set to now − 1h) | `401` | `401 {"error":"invalid token"}` | Pass — not exploitable |
| Token reused after `logout-all` | `401` | First call bumps `token_version`; the pre-bump token then gets `401 {"error":"token revoked"}` from `/api/auth/me` | Pass — not exploitable |
| Login with a wrong password | `401`, no token issued | `401 {"error":"invalid credentials"}`, response body has no `token` field | Pass — not exploitable |
| Login attempted 20 times in a row (fresh username, 20 sequential `POST /api/auth/login`) | Rate limited, not 20×401 | Attempts 1–10 → `401`; attempts 11–20 → `429` | Pass — not exploitable |

No case in the negative table succeeded. Flow A found **zero new
auth-bypass vulnerabilities** — the auth surface held up against every
attack the skill specifies.

### F-038 regression check (old placeholder JWT secret)

Per the task brief, this is now a regression test rather than a fresh finding:
F-038's fix is the `JWT_SECRET` rotation plus the boot-time guard in
`backend/src/auth/assertJwtSecret.js`. The placeholder value it guards against
(`replace-me-with-a-long-random-string-min-32-chars`, taken from that guard's
own `KNOWN_PLACEHOLDERS` set — no `.env.example` file exists at the repo root
today, so the guard source is the authoritative record of the placeholder
text) was used to sign a fresh admin-claiming token (`user_id:1, role:"admin"`)
locally, without touching the live secret.

| Surface | Expected after rotation | Observed |
|---|---|---|
| `GET /api/auth/me` with the old-secret token | `401` | `401 {"error":"invalid token"}` |
| `POST /api/tile-types` (admin route) with the old-secret token | `401` (rejected before the admin-role check even runs) | `401 {"error":"invalid token"}`, no row created |
| WS upgrade to `ws://localhost:13101/authority?token=<old-secret token>` | Connection refused | `onerror` fired, no `onopen`, no handshake completed |

**Result: no regression.** The rotated secret is enforced on both the HTTP
auth path and the co-hosted WS authority upgrade path (`backend/src/index.js`
starts `attachAuthority` on the same listening socket, `/authority`). This was
the most important check in this phase and it passed cleanly.

---

## Static findings arbitrated in Flow A

Findings were considered in scope for Flow A if their `verification` field
named an auth/authorization check reachable through login, tokens, or route
guards (as opposed to crash-safety, resource limits, or game-economy checks,
which belong to Flows B–D and the general arbitration sweep). Only one
qualified:

### F-021 — token-revocation check duplicated between HTTP middleware and WS upgrade (P3, dry)

The finding's own text already anticipated the outcome: *"They agree today
and nothing is currently broken, which is why this is recorded at P3 rather
than higher."* Its `verification` field specifies the exact browser check:
bump a user's `token_version` and assert both an HTTP request and a live WS
upgrade reject the stale token.

Ran it: registered a second account, captured its token, called
`POST /api/auth/logout-all` with that token (bumping `token_version`), then
reused the pre-bump token against both `GET /api/auth/me` (→ `401 token
revoked`) and a live WS upgrade to `/authority?token=...` (→ rejected before
handshake). The two independent checks currently agree — no divergence
observed.

**Verdict: confirmed in browser.** Severity stays at P3 (this was never a
live vulnerability — the finding is about missing regression-test coverage
for a duplicated check, and the browser run corroborates that duplication has
not yet caused drift). `verification` field updated via `store.merge` to
record the browser confirmation; no status change.

No other static finding's `verification` names a browser-checkable
auth/authorization case — F-001, F-012, F-015 name valid-token setup but test
crash/resource-limit behavior (Flow B/C territory); F-002 and F-009 test
missing input/size limits, not an authn/z control; F-019 is a WS
game-economy authorization gap that belongs to Flow D; F-023/F-024/F-025/F-028
are frontend UI-state findings for Flow B/C; F-041 is a static-only
repo/config check. These are left for their respective flows or the general
arbitration sweep.

---

## New findings emitted by Flow A

None. Every case in the skill's Flow A table, plus the F-038 regression
check, held. No `source: 'browser'` findings were filed for this flow.

---

*(Flows B, C, D and the full arbitration sweep are run by later agents, which
append their sections below.)*
