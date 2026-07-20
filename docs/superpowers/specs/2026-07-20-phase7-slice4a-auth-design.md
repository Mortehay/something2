# Phase 7 Slice 4a — Authentication, roles, and the predefined map

**Date:** 2026-07-20
**Plane:** SOMET-78 (admin API unauthenticated) and SOMET-97 (dev identity), plus new work
**Depends on:** SOMET-61 complete (`73e0e4c`)

## Goal

Give the game real accounts: password login, a player role and an admin role, a locked-down admin API, and a canonical world a logged-in player spawns into.

## The two holes this closes

**1. No authentication on any mutating admin endpoint.** `backend/src/index.js` defines no auth middleware at all — no `requireAuth`, no `jwt.verify`. Every `POST`/`PUT`/`DELETE` on `entity-types`, `item-types`, `worlds`, `maps` and sprite upload is open to anyone who can reach the backend.

**2. `/api/dev-token` is an account-takeover primitive**, and this is the severe one. It mints a correctly-signed JWT for any `user_id` supplied in the query string, with no credential check. Verified against the running server: `GET /api/dev-token?user_id=301323069` returned a valid token for an existing player holding 7 items.

The WebSocket authority's JWT verification is sound. The *issuer* is not. So the server-authoritative combat model built across slices 3b-1 through 3b-3 — which never trusts the client with damage, positions, or ownership — has been undermined the whole time by an endpoint that hands out any identity on request.

## Decisions (locked during brainstorming)

1. **Self-serve signup.** Anyone may register a username and password and play.
2. **Admin is seeded, never self-assigned.** The first admin comes from a migration reading env; with no env set, no admin exists.
3. **Two slices.** This one is auth only. Multiple characters and the inventory re-key are slice 4b.
4. **JWT plus a `token_version` column** for revocation — stateless verification is preserved.
5. **Existing anonymous data is discarded**, not migrated.

## Why two slices

The user wants multiple characters per account. That requires re-keying `player_items` and `player_equipment` from `user_id` to `character_id`, which reopens:

- the atomic loot claim CTE, whose contested-grab race test took two review rounds to get right (the first version awaited its actors sequentially and did not test the race at all);
- the drop ownership predicate, which once had a vacuous test that would have permitted cross-account item theft;
- every equip path, including the two-handed hand-slot rules.

Landing that beside brand-new authentication means a regression in either surfaces as one ambiguous failure. Auth ships first, alone, because it is also the urgent one.

## The `users` table

| column | type | notes |
|---|---|---|
| `id` | `serial` PK | |
| `username` | `citext` unique | case-insensitive, so `Bob` and `bob` are one account. Verified available in this Postgres; the migration must `CREATE EXTENSION IF NOT EXISTS citext` itself so a fresh database works without a manual step |
| `password_hash` | `text` | bcrypt |
| `role` | `text` | `CHECK (role IN ('player','admin'))`, default `'player'` |
| `token_version` | `integer` | default 1 |
| `created_at` | `timestamptz` | |

**`role` is never read from a request body.** The registration handler does not accept it, so `{"username":"x","password":"y","role":"admin"}` produces a player. This is a code-level invariant with its own test, not a validation rule that could be relaxed later by accident.

The first admin is created by a migration from `ADMIN_USERNAME` / `ADMIN_PASSWORD`. **If those are unset the migration creates nothing** — no default credentials, ever. Admins may promote others through a protected endpoint.

### Password hashing

**bcryptjs**, chosen over `bcrypt` and `argon2` because both of those need native compilation, which is fragile in this project's Docker setup, and over hand-rolled `crypto.scrypt` because bcryptjs handles salt generation, parameter encoding and constant-time comparison rather than leaving them to be re-implemented. Cost factor 12.

### `user_id` type reconciliation

`user_id` is `integer` in `engine_players` but `text` in `player_items`, `player_equipment` and `world_players`. Since all existing rows are test detritus (20 users, 65 items, worlds named `SeamTest` and `losTest1`–`losTest9`), this slice **normalizes every one of them to `integer` referencing `users(id)`**. Doing it now, while the data is disposable, is far cheaper than after real accounts exist.

## Endpoints

```
POST   /api/auth/register    → create a player, return a token
POST   /api/auth/login       → verify credentials, return a token
POST   /api/auth/logout-all  → bump token_version, invalidating every live token
GET    /api/auth/me          → the caller's identity
POST   /api/admin/users/:id/role → promote or demote (requireAdmin)
```

`/api/dev-token` is **removed**, not guarded and not feature-flagged. A disabled-in-production switch is precisely the thing that gets re-enabled for debugging and forgotten; the endpoint has no reason to exist once login works.

Two middlewares: `requireAuth` (valid, current-version token) and `requireAdmin` (that, plus `role = 'admin'`). Every mutating admin route gets `requireAdmin`. Read endpoints stay open for now — the game client needs the catalog, and locking reads is a separate decision.

**Login is rate-limited** per IP and per username. Without it a password endpoint is only a slower version of the hole being closed.

## Revocation

The JWT carries `token_version`. `requireAuth` and the WebSocket authority both compare it against the user's current row and reject a stale token. Changing a password and calling `logout-all` each bump it.

This keeps verification stateless — one integer comparison against a row already being read — while making "log out everywhere" and "ban a cheater" actually work. A plain long-lived JWT cannot do either until it expires.

## The predefined map

A migration seeds **one canonical world**, and a logged-in player spawns there. World selection, character placement choice, and multi-world routing are out of scope; this is the "predefined map" the feature asked for.

## What this deliberately breaks

Removing `/api/dev-token` breaks every current browser flow and any test that used it. Tests need a helper that registers and logs in properly. That cost is accepted rather than leaving a takeover endpoint alive.

The client currently calls `fetchDevToken` with no arguments on load and is handed an identity. It now needs a real login screen — genuine frontend work, not a token swap.

## Testing

- A password **never** round-trips: no hash in any response body, no plaintext in any log line.
- **Registration cannot set `role`** — post `role: 'admin'` and assert the created user is a player. This is the privilege-escalation test.
- **Every mutating admin route rejects** a missing token, a player's token, and a **stale-version** token.
  **This test must walk Express's real router stack** (`app._router.stack`, verified reachable in Express 4.22.1), enumerating live routes and asserting each mutating one is protected. A hand-maintained list of routes would be a fixture that drifts from reality — the "guard defends a copy instead of the thing" failure this project has already shipped three times. Written this way, a new unprotected admin route added next year fails this test instead of slipping through.
- `logout-all` invalidates an **already-issued** token.
- A stale-version token is rejected by the **WebSocket authority**, not only by HTTP.
- Login rate limiting actually triggers, and does not lock out a different user on the same IP.
- **`GET /api/dev-token` returns 404** — a direct regression test against the takeover primitive.
- Username uniqueness is case-insensitive.
- The admin-seed migration with no env set creates **no** user.

Live browser verification must cover: registering, logging out and back in, a player being refused the admin UI, an admin editing item types successfully, and a logged-in player spawning on the canonical map with their inventory intact across a reload — which is also the SOMET-97 fix.

## Out of scope

Multiple characters and the inventory re-key (slice 4b); email addresses, verification, and password reset; OAuth and 2FA; an admin user-management UI beyond promote/demote; locking down read endpoints; account deletion; audit logging of admin actions.

## Known risks to watch, not to pre-solve

- **The route-walking protection test is the highest-value test in the slice and the easiest to get subtly wrong.** If it silently matches zero routes it passes while proving nothing. It must assert it found a plausible number of mutating routes before checking them.
- Normalizing `user_id` to `integer` touches the loot and equipment tables. Those tables' *logic* is untouched, but their column type is not — the existing loot tests must pass unmodified, and if one needs changing that is a signal to stop.
