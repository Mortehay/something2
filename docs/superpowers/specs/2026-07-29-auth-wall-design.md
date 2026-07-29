# Auth Wall — hide the whole site behind sign-in

**Goal:** an unauthenticated visitor sees exactly one thing — the sign-in screen — and can read
nothing from the API. Accounts are created by an admin, not by self-registration.

## Why this is not a small change

Today the sign-in card is a curtain hung inside one room of an open house:

- **The gate is nested inside the game.** `frontend/src/games/something2/Something2.jsx:629`
  returns `<Login>` when `!authed`. It renders *inside* `AppLayout`, so the logo, header and
  sidebar (with the page names) draw around it. That is the visual symptom.
- **There is no route guard and no `/login` route.** `frontend/src/App.jsx:33-40` mounts
  `/dashboard` and `/game-something2` under `AppLayout` with no auth check at all. `/dashboard`
  renders fully signed-out.
- **Every API read is public.** All 17-ish mutating routes correctly sit behind `adminGuard`, but
  ~22 `GET /api/*` routes have no guard: `/api/maps`, `/api/map/config`, `/api/map/tiles`,
  `/api/entity-types`, `/api/item-types`, `/api/vfx-effects`, `/api/tile-types`, `/api/biomes`,
  `/api/maps/:id`, `/api/maps/:id/entities`, `/api/sprite-capability`, `/api/sprite-jobs/:jobId`,
  `/api/entity-jobs/:jobId`, `/api/tile-jobs/:jobId`, `/api/worlds`, `/api/worlds/:id`,
  `/api/worlds/:id/links`, `/api/worlds/:id/villages`, `/api/worlds/:id/chunk`,
  `/api/worlds/:id/preview`, `/api/worlds/:id/overview`.
- **Self-registration is open.** `POST /api/auth/register` is public and mints `role='player'`.
  While it stays open, a wall stops only visitors unwilling to click "Register".

So hiding the UI alone would fix the screenshot without fixing the problem.

## What is already right (build on it, don't rebuild it)

- `backend/src/auth/middleware.js` — `requireAuth(pool)` and `requireAdmin(pool)`, both tagged
  `isAuthGuard` / `isAdminGuard` specifically so a test can find them in the router stack.
  Fails **closed** on a DB error (500, never a crash) and enforces `token_version` revocation.
- `GET /api/auth/me` (`requireAuth`) — returns `{ id, username, role }`. The natural
  session-validation endpoint.
- `backend/tests/auth_protection.test.js` — walks the **real** Express router stack rather than a
  hand-maintained list, with an explicit anti-vacuity floor. This is the enforcement contract.
- `backend/tests/helpers/auth.js` — `adminToken()`, `authHeaders()`, `withAuth(queryFn)`.
- `frontend/src/games/something2/src/js/net/auth.js` — token storage, expiry parsing,
  `authHeaders()`, `apiFetch()` with automatic 401 handling, and `AUTH_EXPIRED_EVENT`.
- `make admin-password` (`backend/scripts/set-admin-password.js`) — bootstraps the admin from
  `.env`. This is why closing registration cannot lock you out.

## Decisions

| Decision | Choice |
|---|---|
| Wall depth | **UI and API both.** Signed-out gets the sign-in screen; guarded GETs return 401. |
| Registration | **Closed.** `POST /api/auth/register` becomes admin-only; the Register link goes. |
| Frontend gate | **`AuthProvider` + `ProtectedRoute`**, with a real `/login` route. |

### The one deviation, and why

You asked for the API sealed *including* assets. That is not implementable as stated:
`frontend/src/games/something2/src/js/managers/ImageManager.js:11-12` loads sprites with
`new Image(); img.src = url` against `/api/assets/*`. A browser image request cannot carry an
`Authorization: Bearer` header, so `requireAuth` on that route breaks every sprite in the game.

**This spec allowlists `/api/assets/*`.** What leaks is generated sprite PNGs and sprite JSON —
art, not world state, player data, or map layout. Everything of substance
(`/api/worlds/:id/chunk`, `/api/maps/*`, `/api/biomes`, `/api/entity-types`) is sealed.

If sealing the art matters too, the follow-up is a **session cookie**: set an httpOnly cookie at
login and have `/api/assets/*` accept cookie *or* Bearer, since browsers attach cookies to `<img>`
requests automatically. That needs `SameSite=None; Secure` and a CORS credentials pass because the
SPA and API are separate origins in dev. Deliberately out of scope here — flagged, not silently
dropped.

`/api/health` is also allowlisted (liveness/monitoring). Note: nothing in `compose/` or `engine/`
currently consumes it.

## Architecture

### Backend — seal the reads

1. Add `requireAuth(guardPool)` to every `/api/*` route not in the public allowlist. Reads become
   `requireAuth` (any signed-in user); writes keep `requireAdmin` (unchanged).
2. Public allowlist, exhaustive and explicit: `GET /api/health`, `GET /api/assets/*`,
   `POST /api/auth/login`.
3. `POST /api/auth/register` gains `requireAdmin(pool)`. The rate limiter stays. `role` remains the
   `'player'` literal, never sourced from the body. The endpoint still returns a token for the
   created user; no client stores it (the admin's own session is unaffected). Stripping that token
   from the response is optional hardening, not required here.

### Backend — make the wall un-drift-able

Widen `auth_protection.test.js` from mutating-only to **every** `/api` method:

- Rename `mutatingLayers()` → `apiLayers()`; drop the `['post','put','delete']` filter so `get` is
  included.
- Replace the blanket `!path.startsWith('/api/auth')` skip with an explicit `PUBLIC_ROUTES` set
  holding the three allowlisted entries above. An unguarded route now fails the test unless
  somebody deliberately adds it to that set — which is a visible, reviewable act.
- Raise the anti-vacuity floor. The guarded surface becomes roughly 38 routes (~17 mutating + ~21
  reads); set the floor from the measured count less a small margin, and keep the existing
  "a zero/low match proves nothing" assertion.

This single test is the design's real guarantee: it reads the live router stack, so a route added
next month without a guard fails CI.

### Backend — the test migration (the bulk of the work)

15 test files call `GET /api/*` and will start getting 401:
`tile_map_fields`, `vfx_effects_api`, `overview_route`, `item_types_api`, `worlds`,
`wall_fields_serialization`, `villageCreateTransaction`, `worldPreviewRoute`, `auth_routes`,
`assets_route`, `sprite`, `biomesApi`, `worldLinksRoutes`, `chunk_decorations_api`,
`auth_protection`.

The fix is mechanical and the tooling already exists: import `tests/helpers/auth.js` first, wrap
the pool with `withAuth(...)`, and add `.set(authHeaders())` to the GET calls. `assets_route`
should *not* need a token — it covers an allowlisted route, and that is worth an explicit
assertion.

Each migrated file must still fail if the route's own logic breaks — do not let a token paper over
a genuine assertion. Any test that was implicitly relying on anonymous access should gain a
companion case asserting **401 without a token**, so the guard itself is covered rather than just
tolerated.

### Frontend — one place owns the session

**`frontend/src/context/AuthContext.jsx`** (new) — `AuthProvider` + `useAuth()`.

- State: `status` is `'loading' | 'authed' | 'anon'`; `user` is `{ id, username, role }` or null.
- Boot: if `getStoredToken()` returns a token, validate it with `GET /api/auth/me`. 200 → `authed`
  with the server's user; 401 → `clearToken()` and `anon`. This is a real upgrade over today's
  `parseJwt(...)` check at `Something2.jsx:391`, which trusts client-parsed claims and cannot see a
  revoked-but-unexpired token.
- `signIn(username, password)` wraps `login()` + `storeToken()`; `signOut()` clears and resets.
- Subscribes to `AUTH_EXPIRED_EVENT` **once**, here. The listener currently lives at
  `Something2.jsx:424` and must move — left there, a session revoked while the tab is open leaves
  the whole shell rendered.

**`frontend/src/ui/ProtectedRoute.jsx`** (new) — `loading` → `<Spinner />` (already in `ui/`);
`anon` → `<Navigate to="/login" replace state={{ from: location }} />`; `authed` → `<Outlet />`.

Rendering a spinner while `loading` is what stops a one-frame flash of the app shell on reload.

**`frontend/src/App.jsx`** — wrap in `<AuthProvider>` (inside `QueryClientProvider`, so the
provider can use query hooks if it later needs to). Routes become:

```
/login                      → <Login />                 (standalone, no AppLayout)
<ProtectedRoute>            → <AppLayout>
  index                     → Navigate to dashboard
  dashboard                 → <Dashboard />
  game-something2           → <GameSomething2 />
*                           → <PageNotFound />
```

**`frontend/src/pages/Login.jsx`** — becomes a route component: no `apiUrl`/`onAuthed` props, uses
`useAuth().signIn`, and on success navigates to `location.state?.from ?? '/dashboard'`. The
"Need an account? Register" toggle and the `register` import are removed. `register()` stays in
`net/auth.js` — it is still the client for the now-admin-only endpoint and is unit-tested.

**`frontend/src/games/something2/Something2.jsx`** — delete the `!authed` early return (~line 629),
the `Login` import, the local `authed` state (~386), the `AUTH_EXPIRED_EVENT` listener (~424), and
the `parseJwt` role derivation (~391). `isAdmin` becomes `useAuth().user?.role === 'admin'`. The
effects currently keyed on `authed` (~400, 412, 548) key on nothing auth-related any more — inside
a `ProtectedRoute` the component only mounts when authed. Preserve the *other* reasons those
effects re-run (`activeTab`, map inputs); the F-045 rebinding behaviour at ~505-548 must not
regress.

### Frontend — out of scope

The Go engine's WebSocket upgrade already verifies the JWT and shares the revocation check
(`backend/src/authority/server.js:186`). No engine change. Say so explicitly so a reviewer does not
go looking.

## Data flow

**Cold load, signed out:** `AuthProvider` finds no token → `anon` → `ProtectedRoute` redirects to
`/login` → only the sign-in screen renders. No shell, no sidebar, no page names.

**Cold load, valid token:** `loading` (spinner) → `/api/auth/me` 200 → `authed` → shell renders.

**Cold load, revoked token:** `/api/auth/me` 401 → token cleared → `anon` → `/login`. Today this
state renders the app and 401s on every write instead.

**Sign-in:** `signIn()` → token stored → `authed` → navigate to the remembered destination.

**Session dies mid-session:** any `apiFetch` 401 → `noteAuthFailure` clears the token and
dispatches `AUTH_EXPIRED_EVENT` → `AuthProvider` flips to `anon` → redirect to `/login`.

## Error handling

- Guard DB failure → 500 (`authenticate()` already fails closed and cannot crash the process).
- `/api/auth/me` network failure at boot is **not** proof of a bad token: treat a non-401 failure
  as `anon` for this pass (fail closed, user re-signs in) rather than inventing a retry/offline
  mode. Simple and safe; revisit only if it proves annoying in practice.
- Login errors keep the existing generic "invalid credentials" 401 — never reveal which field was
  wrong.
- Rate limiting on login is unchanged (10 per 15 min per IP+username).

## Testing

**Backend** (`node --test`):
- The widened `auth_protection.test.js` — the contract. Must fail if any `/api` route lacks a guard.
- `POST /api/auth/register` → 401 with no token, 403 as a `player`, 201 as an `admin`.
- One representative read (`GET /api/worlds`) → 401 anonymous, 200 with a token.
- `GET /api/assets/*` and `GET /api/health` → 200 anonymous (the allowlist is deliberate, so it is
  asserted, not assumed).
- The 15 migrated files still pass on their original assertions.

**Frontend** (vitest, node env — no jsdom, so favour logic over rendering):
- `AuthContext`: boot with no token → `anon`; valid token + `/me` 200 → `authed` with the server's
  role; `/me` 401 → token cleared, `anon`; `AUTH_EXPIRED_EVENT` → `anon`.
- `ProtectedRoute`: `loading` → spinner, `anon` → redirect, `authed` → children.
- Existing `net/auth.js` tests must keep passing untouched — that module is not changing.

**Browser pass** (the one thing tests cannot show): load signed-out and confirm no sidebar, header,
logo or page names are present in the DOM — not merely visually hidden. Then sign in and confirm
sprites still render, which is the assets-allowlist decision paying off or failing loudly.

## Operations

- Bootstrap/recovery: `make admin-password` (existing) — unchanged, and the reason closing
  registration is safe.
- Creating players after this change: an admin `POST /api/auth/register` with their bearer token.
  No admin UI for it in this scope; if that becomes tedious, a `make create-user` script is the
  natural follow-up.
- No migration. No schema change. `users`, `token_version`, and roles are all already in place.
