# Email Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accounts get a verified email; the login page gains "Request invite code" and "Forgot password"; admins approve/reject invite requests in `/game/invites`; all mail goes out through Gmail SMTP.

**Architecture:** Backend: one migration, an `email/` module (mailer, templates, link origin), an `emailTokens` module (hashed single-use UUID tokens), a verification gate folded into the existing single auth check (`currentUserForToken`) so HTTP and WS cannot diverge, and two new routers. Frontend: shared auth-card styles, extended Login page, two landing pages, a blocking `EmailGate` inside `RequireAuth`, and an admin tab.

**Tech Stack:** Express + raw `pg` + node-pg-migrate, `nodemailer` (new dep), `node:test` + supertest; React 19 + styled-components + TanStack Query, vitest (node env — pure models only; UI verified in the browser).

**Spec:** `docs/superpowers/specs/2026-11-12-email-accounts-design.md` — read it first; this plan does not repeat its rationale.

## Global Constraints

- Work in a worktree on branch `feat/email-accounts` (AGENTS.md "Worktrees"; never checkout/stash/reset the shared checkout). Link `node_modules` back to the main checkout; `nodemailer` must be added to `backend/package.json` and installed in the MAIN checkout's `backend/` too so the symlink sees it.
- Gate is active only when `SMTP_HOST`, `SMTP_USER` and `SMTP_PASS` are all set, or `EMAIL_GATE_FORCE=1` (tests). Inactive ⇒ behaviour identical to today.
- No SMTP ⇒ console sender (logs to, subject, and the link line). Tests never reach Gmail.
- `SMTP_PASS` whitespace is stripped before use.
- Tokens: `crypto.randomUUID()` in the link, `sha256` hex stored. Verify TTL 24 h, reset TTL 1 h, resend cooldown 60 s.
- Rate limits: invite request 5/h per IP; forgot password 3/h per email and 10/h per IP.
- Rejected email: no new request for 7 days.
- Enumeration-safe copy (exact):
  - invite request → `{ ok: true }`, UI text "Request received. If it's approved you'll get a code by email. Not there? Check your spam folder."
  - forgot → `{ ok: true }`, UI text "If that email belongs to an account, a reset link is on its way. Check spam too."
- Error codes (JSON `error` field): `email_not_verified` (403), `email_taken` (409), `email_locked` (409), `resend_cooldown` (429, plus `retryAfterSec`), `link_expired` (410), `email_failed` (502), `no_link_origin` (500), `invalid_email` (400).
- Email palette (from `frontend/src/pages/Login.jsx`): page `#0f0f1a`, card `#1a1a2e`, border `#2e2e3e`, button `#4a9eff`, heading `#ffffff`, body `#b8b8c8`.
- Never log `req.body`, tokens, codes or `SMTP_PASS`.
- Mail settings must reach the Orange Pi: compose passthrough (Task 2) AND the board's `.env` values, copied from the Orange Pi tab's ".env sync" box (Task 15).
- DB tests skip without `TEST_DATABASE_URL` (pattern: `backend/tests/invite_codes_db.test.js`); never run against the shared dev DB. Focused run: `cd backend && node scripts/testdb.js run -- tests/<file>`; full: `node scripts/testdb.js run` — read the EXIT CODE.
- Every new UI string goes through `t()` and gets a `uk` entry in `frontend/src/games/something2/src/js/i18n/uk/react.js`.
- Commit subject `type(scope): summary`; trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Gate bypass via a route that does not use `requireAuth`/`requireAdmin`** — any authenticated API must refuse an unverified user when the gate is active. Task 5 adds a route-stack test asserting every auth-guarded route except the allowlist refuses.
2. **Mixed-case / whitespace emails** (`  Bob@Gmail.COM `) must hit the same account, request and lock as `bob@gmail.com`. Task 6 tests `normalizeEmail`; Tasks 7–9 each include one mixed-case case.
3. **Double-click Approve** (two concurrent approves) must mint one code and send one email. Task 9 races two approves.
4. **Tunnel host changed / forged `Origin`** — never mail a link to a non-allowlisted, non-same-origin host. Task 3 tests forged-origin and no-origin.
5. **Gmail outage mid-approve** leaves the request pending and no orphan code. Task 9 tests rollback with a throwing sender.

---

### Task 1: Migration

**Files:**
- Create: `backend/migrations/1714440886000_email_accounts.js` (re-check `ls backend/migrations | sort | tail -3` first; bump if taken)
- Test: `backend/tests/email_accounts_schema_db.test.js`

**Produces (schema):**
- `users.email citext NULL`, `users.email_verified_at timestamptz NULL`; unique index `users_verified_email_unique` on `(email) WHERE email_verified_at IS NOT NULL`.
- `invite_codes.email citext NULL`.
- `invite_requests(id serial PK, email citext NOT NULL, note text CHECK (char_length(note) <= 300), status text NOT NULL DEFAULT 'pending' CHECK IN ('pending','approved','rejected'), created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz, decided_by integer REFERENCES users ON DELETE SET NULL, invite_code citext REFERENCES invite_codes(code) ON DELETE SET NULL)`; unique index `invite_requests_one_pending` on `(email) WHERE status='pending'`.
- `email_tokens(token_hash text PK, user_id integer NOT NULL REFERENCES users ON DELETE CASCADE, purpose text NOT NULL CHECK IN ('verify_email','reset_password'), email citext NOT NULL, expires_at timestamptz NOT NULL, used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now())`; index on `(user_id, purpose)`.
- `down` drops all of it.

- [ ] **Step 1: Write failing test** `schema has email account tables`: inserts two users with the same verified email ⇒ second fails with code `23505`; same email unverified twice ⇒ succeeds; two pending `invite_requests` for `A@x.com`/`a@x.com` ⇒ `23505`; one pending + one rejected ⇒ OK. Clean up rows in `t.after`.
- [ ] **Step 2:** `node scripts/testdb.js run -- tests/email_accounts_schema_db.test.js` → FAIL (relation does not exist).
- [ ] **Step 3:** Write the migration.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5:** Commit `feat(auth): email accounts schema`.

### Task 2: Mailer, templates, config plumbing

**Files:**
- Create: `backend/src/email/mailer.js`, `backend/src/email/templates.js`
- Modify: `backend/package.json` (add `nodemailer`), `compose/develop/docker-compose.yml` and `compose/orangepi/docker-compose.yml` (backend env: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `APP_URL`, each `${VAR:-}`), `.env.example` (same names, blank, with a comment pointing at the spec)
- Test: `backend/tests/email_mailer.test.js`, `backend/tests/email_templates.test.js`

**Produces:**
- `smtpConfigured(env = process.env) -> boolean` — HOST, USER, PASS all non-empty.
- `sendEmail({ to, subject, text, html }, { env = process.env, createTransport = nodemailer.createTransport, log = console.log } = {}) -> Promise<void>` — throws on SMTP failure. Transport: `{ host, port: Number(SMTP_PORT||587), secure: port === 465, auth: { user, pass: pass.replace(/\s+/g,'') } }`; `from: MAIL_FROM || SMTP_USER`. Unconfigured ⇒ `log('[email:console]', to, subject, <first http(s) URL in text>)`.
- Test seam: `__setSender(fn | null)` — when set, `sendEmail` calls `fn(message)` instead of SMTP/console. Tasks 6–9 tests capture mail through it.
- Templates, each `-> { subject, text, html }`: `inviteApprovedEmail({ code, link })`, `inviteRejectedEmail()`, `verifyEmailEmail({ link })`, `resetPasswordEmail({ link })`. One internal `layout({ heading, bodyHtml, button: { label, href } | null })`. Subjects: "Your Something2 invite code", "About your Something2 invite request", "Verify your Something2 email", "Reset your Something2 password".

- [ ] **Step 1: Failing tests.** Mailer: `console sender when unconfigured` (fake `createTransport` never called, `log` called with the URL); `strips spaces from SMTP_PASS` (`'abcd efgh ijkl mnop'` ⇒ transport auth pass `'abcdefghijklmnop'`); `rethrows transport failure`. Templates: for each template, `text` and `html` both contain the link/code; html contains `#4a9eff` and `#1a1a2e`; a link containing `"><script>` appears HTML-escaped in `html`; html has no `<img`, no `<link`, no `<style`.
- [ ] **Step 2:** Run both → FAIL.
- [ ] **Step 3:** Implement; table-based HTML with inline styles, the link also printed as text under the button, footer "If you didn't ask for this, ignore this email."
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(email): gmail smtp mailer and templates`.

### Task 3: Link origin

**Files:** Create `backend/src/email/linkOrigin.js`; Test `backend/tests/email_link_origin.test.js`

**Produces:** `linkOrigin(req, env = process.env) -> string | null` (no trailing slash). Order: (1) `Origin` header in `CORS_ORIGINS` (comma list) or equal to `APP_URL`; (2) `Origin` host equals `Host` header ⇒ that origin; (3) `APP_URL`; (4) first `CORS_ORIGINS` entry; (5) `null`. Missing `Origin`: fall back from step 3.

- [ ] **Step 1: Failing tests:** allowlisted `http://localhost:15173` returned; same-origin `https://abc.trycloudflare.com` with `Host: abc.trycloudflare.com` returned with empty `CORS_ORIGINS`; forged `Origin: https://evil.example` + `Host: abc.trycloudflare.com` ⇒ falls to `APP_URL` (`https://app.test`), and to `null` when `APP_URL`/`CORS_ORIGINS` empty; no Origin ⇒ `APP_URL`.
- [ ] **Step 2–4:** Run FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(email): trusted link origin`.

### Task 4: Email tokens

**Files:** Create `backend/src/auth/emailTokens.js`; Test `backend/tests/email_tokens_db.test.js`

**Produces:**
- `VERIFY_TTL_MS = 24*3600e3`, `RESET_TTL_MS = 3600e3`.
- `issueEmailToken(db, { userId, purpose, email, ttlMs }) -> Promise<string>` — marks the user's unused tokens of that purpose used (`used_at = now()`), inserts the sha256 of a new `randomUUID()`, returns the raw UUID.
- `consumeEmailToken(db, raw, purpose) -> Promise<{ userId, email } | null>` — one conditional `UPDATE … WHERE token_hash=$1 AND purpose=$2 AND used_at IS NULL AND expires_at > now() RETURNING user_id, email` (same pattern as `claimInviteCode`). Non-UUID input ⇒ `null` without querying.
- `peekEmailToken(db, raw, purpose) -> Promise<boolean>`.
- `lastIssuedAt(db, userId, purpose) -> Promise<Date | null>` (resend cooldown).

- [ ] **Step 1: Failing tests:** issue→consume returns `{userId,email}`, second consume `null`; two clients consuming concurrently ⇒ exactly one non-null; expired (`ttlMs: -1000`) ⇒ `null`; reissue kills the first token; DB row's `token_hash` ≠ raw and is 64 hex chars; wrong purpose ⇒ `null`; `peek` true then false after consume.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(auth): single-use hashed email tokens`.

### Task 5: Verification gate (HTTP + WS, one check)

**Files:**
- Modify: `backend/src/auth/tokens.js`, `backend/src/auth/middleware.js`, `backend/src/authority/server.js:784-794`, `backend/src/auth/routes.js` (`/me`, `/logout-all`)
- Test: `backend/tests/auth_email_gate.test.js`; extend `backend/tests/authority_server.test.js`

**Interfaces:**
- `emailGateActive(env = process.env) -> boolean` = `smtpConfigured(env) || env.EMAIL_GATE_FORCE === '1'` (in `tokens.js`).
- `currentUserForToken(pool, payload)` — when the gate is **inactive** runs today's exact query (`SELECT token_version, role FROM users WHERE id = $1`, so the 4 existing fake pools stay valid) and returns `{ id, username, role }`. When **active** runs `SELECT token_version, role, email_verified_at FROM users WHERE id = $1` and adds `emailVerified: boolean`.
- `isEmailGated(user) -> boolean` = `user.emailVerified === false`.
- `requireAuth(pool, { allowUnverified = false } = {})`, same option on `requireAdmin` — gated ⇒ `403 { error: 'email_not_verified' }`. Guards keep `isAuthGuard`/`isAdminGuard` and gain `allowsUnverified` marker.
- WS upgrade: `isEmailGated(user)` ⇒ `socket.destroy()`.
- `GET /api/auth/me` (allowUnverified) returns `{ id, username, role, email, emailVerified, emailRequired }` — `email`/`emailVerified` read from the row (one extra query only here), `emailRequired = emailGateActive()`. `/logout-all` allowUnverified.

- [ ] **Step 1: Failing tests** (in-memory pool, `EMAIL_GATE_FORCE=1` set/restored per test): unverified token ⇒ `/api/characters` 403 `email_not_verified`; verified ⇒ not 403; `/api/auth/me` 200 for unverified with `emailVerified:false, emailRequired:true`; gate off ⇒ unverified gets through and the fake sees only the old SQL; **route-stack test**: walk `app._router.stack`, every layer whose handle has `isAuthGuard` and not `allowsUnverified` is on a path outside the allowlist (`/api/auth/me`, `/api/auth/logout-all`, `/api/auth/email`, `/api/auth/email/resend`), and the allowlisted ones carry the marker. WS: unverified token upgrade is destroyed when forced, accepted when not.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the new file, `auth_routes`, `auth_middleware`, `auth_protection`, `auth_tokens`, `authority_server` → PASS.
- [ ] **Step 5:** Commit `feat(auth): email verification gate on http and ws`.

### Task 6: Set email, resend, verify

**Files:**
- Create: `backend/src/auth/emailAddress.js`, `backend/src/auth/accountEmailRoutes.js` (mounted from `routes.js` on the same router)
- Test: `backend/tests/email_address.test.js`, `backend/tests/account_email_routes_db.test.js`

**Produces:**
- `normalizeEmail(raw) -> string | null` — trim, lowercase, ≤254 chars, `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`.
- `verifiedHolder(db, email, exceptUserId?) -> Promise<number | null>`; `isEmailLocked(db, userId) -> Promise<boolean>` (a code with `email` NOT NULL and `used_by = userId`).
- `sendVerification(db, req, user, email) -> Promise<void>` — `linkOrigin` (null ⇒ throw `no_link_origin`), issue token, `verifyEmailEmail({ link: origin + '/verify-email/' + raw })`, `sendEmail`. Used again by Task 7.
- `POST /api/auth/email {email}` (allowUnverified): invalid ⇒ 400 `invalid_email`; already verified ⇒ 409 `email_locked`; locked registration and email differs ⇒ 409 `email_locked`; verified elsewhere ⇒ 409 `email_taken`; else set `email`, clear `email_verified_at`, send ⇒ 200 `{ email }`; send failure ⇒ 502 `email_failed` (email stays set).
- `POST /api/auth/email/resend` (allowUnverified): no email ⇒ 400 `invalid_email`; last issue < 60 s ⇒ 429 `resend_cooldown` + `retryAfterSec`; else send ⇒ 200.
- `POST /api/auth/verify-email {token}` (public): consume; null ⇒ 410 `link_expired`; token email ≠ account email ⇒ 410; verified elsewhere ⇒ 409 `email_taken`; else set `email_verified_at = now()` ⇒ 200.

- [ ] **Step 1: Failing tests:** `normalizeEmail` table (`'  Bob@Gmail.COM '`→`'bob@gmail.com'`, `'a@b'`→null, 255 chars→null). Routes (real DB, `EMAIL_GATE_FORCE=1`, mail captured with Task 2's `__setSender`, reset in `t.after`): set→resend within 60 s ⇒ 429; token from the captured link verifies, `/me` then `emailVerified:true` and `/api/characters` no longer 403; reusing the link ⇒ 410; change email after sending ⇒ old link 410; second account claiming a verified email ⇒ 409 `email_taken`; mixed-case email collides with lowercase; locked account changing email ⇒ 409 `email_locked`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(auth): set, resend and verify account email`.

### Task 7: Registration with email

**Files:** Modify `backend/src/auth/routes.js` (`/register`), `backend/tests/auth_routes.test.js` (fakes send `email`), `backend/tests/invite_codes_db.test.js` (pass `email`); Test add cases to `backend/tests/account_email_routes_db.test.js`

**Interfaces:** body `{ username, email, password, inviteCode? }`. Missing/invalid email ⇒ 400 `invalid_email`; verified holder ⇒ 409 `email_taken`; in invite mode, the claimed code's `email` set and ≠ normalized email ⇒ 403 `invalid or already-used invite code` (same message as a bad code; claim rolled back). INSERT stores `email`. After commit `sendVerification` — failure logged as `register: verification email failed`, response still 201. Response `user` adds `email`, `emailVerified:false`.

- [ ] **Step 1: Failing tests:** register without email ⇒ 400; email-locked code with matching mixed-case email ⇒ 201 and a verification mail captured; with another email ⇒ 403 and the code still unused; sender throwing ⇒ still 201.
- [ ] **Step 2–4:** FAIL → implement → PASS (incl. existing `auth_routes`, `invite_codes_db`, `invite_codes_cli_db`).
- [ ] **Step 5:** Commit `feat(auth): registration requires email`.

### Task 8: Forgot / reset password

**Files:** Create `backend/src/auth/passwordResetRoutes.js` (mounted on the auth router); Test `backend/tests/password_reset_routes_db.test.js`

**Interfaces:**
- `POST /api/auth/password/forgot {email}` — limits per Global Constraints; always 200 `{ ok: true }`. Target: verified holder, else the single account holding it unverified, else nobody. Sends `resetPasswordEmail` to `origin + '/reset-password/' + raw`. Send errors and null origin are logged, never surfaced.
- `GET /api/auth/password/reset/:token` ⇒ `{ live: boolean }` (peek).
- `POST /api/auth/password/reset {token, password}` — empty password ⇒ 400; consume null ⇒ 410 `link_expired`; set hash, `token_version + 1`, and if token email = account email and no other verified holder set `email_verified_at = now()` ⇒ 200.

- [ ] **Step 1: Failing tests:** unknown email and known email return byte-identical bodies; verified account gets a mail, two unverified holders of one address ⇒ none; reset ⇒ old JWT 401 on `/me`, login with new password works, `emailVerified` true; second use ⇒ 410; 4th forgot in an hour for one email ⇒ still 200 but no 4th mail.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(auth): password reset by email`.

### Task 9: Invite requests (public + admin)

**Files:**
- Create: `backend/src/auth/inviteCodeGen.js` (move `ALPHABET` + `mintCode` from `backend/scripts/invite-codes.js`, which then requires it), `backend/src/auth/inviteRequestRoutes.js` (mount in `backend/src/index.js` next to `/api/auth`)
- Test: `backend/tests/invite_requests_routes_db.test.js`

**Interfaces:**
- `GET /api/auth/options` ⇒ `{ registrationMode, inviteRequests: registrationMode === 'invite' }`.
- `POST /api/auth/invite-requests {email, note}` — only in invite mode (else 404); invalid email ⇒ 400 `invalid_email`; always `{ ok: true }`. No row if pending exists, verified holder exists, or a rejection newer than 7 days. Note trimmed, >300 ⇒ cut to 300.
- `GET /api/admin/invite-requests?status=pending|approved|rejected|all` (requireAdmin) ⇒ `{ requests: [{ id, email, note, status, createdAt, decidedAt, decidedBy, inviteCode, codeUsed }] }` newest first.
- `POST /api/admin/invite-requests/:id/approve` — txn: `SELECT … FOR UPDATE` where `status='pending'` (none ⇒ 409 `not_pending`), insert code (`email`, `note = 'request <id>'`), update request, send `inviteApprovedEmail({ code, link: origin + '/login?register=1&invite=' + code + '&email=' + encodeURIComponent(email) })`, COMMIT. Send failure/null origin ⇒ ROLLBACK, 502 `email_failed` / 500 `no_link_origin`. Success ⇒ `{ request }`.
- `POST /api/admin/invite-requests/:id/reject` — same shape with `inviteRejectedEmail()`.

- [ ] **Step 1: Failing tests:** open mode ⇒ 404; duplicate pending (`A@x.com` then `a@x.com`) ⇒ one row, both `{ok:true}`; recently rejected ⇒ no row; approve ⇒ code row with `email`, mail contains code, register with it works (Task 7); **two concurrent approves** ⇒ one 200, one 409, one code, one mail; throwing sender ⇒ 502, request still pending, no new `invite_codes` row; non-admin ⇒ 403; `invite_codes_cli_db` still green.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(auth): invite requests with admin approval`.

### Task 10: Operator CLI

**Files:** Create `backend/scripts/set-user-email.js`; Modify `.ai/commands.md` (one line); Test `backend/tests/set_user_email_cli_db.test.js`

**Interfaces:** `node scripts/set-user-email.js <username> <email>` — normalizes, refuses (exit 1) if another account has it verified, sets `email` + `email_verified_at = now()`, prints `ok: <username> <email> (verified)`. Uses the same `DATABASE_URL`/dotenv loading as `set-admin-password.js`.

- [ ] **Step 1: Failing test** spawning the script against `TEST_DATABASE_URL`: success sets both columns; conflicting verified email ⇒ exit 1 and no change.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(auth): cli to set a verified email`.

### Task 11: Frontend API client + login page flows

**Files:**
- Create: `frontend/src/games/something2/src/js/net/accountApi.js`, `frontend/src/pages/authCard.jsx` (extract `Screen`, `Card`, `Title`, `Field`, button, link, error, notice styles from `Login.jsx`), `frontend/src/pages/loginModel.js`
- Modify: `frontend/src/pages/Login.jsx`, `frontend/src/games/something2/src/js/net/auth.js` (`register(apiUrl, username, password, inviteCode, email)`), `uk/react.js`
- Test: `frontend/src/pages/__tests__/loginModel.test.js`

**Produces:**
- `accountApi.js`: `getAuthOptions()`, `requestInvite(email, note)`, `forgotPassword(email)`, `checkResetToken(token)`, `resetPassword(token, password)`, `verifyEmail(token)`, `setEmail(email)`, `resendVerification()`, `fetchMe()` — each resolves parsed JSON or throws `Error` whose `.code` is the server `error` and `.retryAfterSec` when present. Uses `API_URL` from `frontend/src/config` and `apiFetch`/`authHeaders` for authed calls.
- `loginModel.js`: `loginBannerFor(searchParams) -> { kind: 'ok'|'error', text } | null` for `verified=1` ("Your email is verified — you can sign in"), `reset=1` ("Password changed — sign in with the new one"), `link=expired` ("This link was already used or has expired — request a new one"); `registerPrefill(searchParams) -> { register: boolean, invite: string, email: string }`; `errorText(code) -> string` for every Global Constraints error code.
- Login card modes `signin | register | request | forgot`. Links under the form: "Forgot password?" always; "Request invite code" only when `options.inviteRequests`. Register adds an email field (required). Banner shown once, then the query is replaced (`navigate(..., { replace: true })`).

- [ ] **Step 1: Failing tests** for `loginBannerFor`, `registerPrefill` (`?register=1&invite=ABCD-EFGH-JKMN&email=a%40b.co`), and `errorText` covering every code.
- [ ] **Step 2–4:** `cd frontend && npx vitest run src/pages/__tests__/loginModel.test.js` FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(login): email, invite request and forgot password forms`.

### Task 12: Verify-email and reset-password pages

**Files:** Create `frontend/src/pages/VerifyEmail.jsx`, `frontend/src/pages/ResetPassword.jsx`; Modify `frontend/src/App.jsx` (routes `verify-email/:token`, `reset-password/:token` next to `login`, outside `RequireAuth`), `uk/react.js`

**Behaviour:** VerifyEmail calls `verifyEmail` once on mount (guard against StrictMode double-run with a ref), then `navigate('/login?verified=1')` or `'/login?link=expired'`; `email_taken` shows `errorText`. ResetPassword calls `checkResetToken` on mount (dead ⇒ `/login?link=expired`), form: new password + repeat (must match, non-empty), submit ⇒ `/login?reset=1`. Both use `authCard.jsx`. A signed-in user who verifies is sent to `/login?verified=1` too; `LoginRoute` already redirects signed-in users, and the gate disappears on the next `/me` (Task 13).

- [ ] **Step 1:** Implement (no pure logic beyond Task 11's model).
- [ ] **Step 2:** `npx vitest run` → PASS; `npx eslint src/pages` clean.
- [ ] **Step 3:** Commit `feat(login): verify-email and reset-password pages`.

### Task 13: Email gate in the app

**Files:** Create `frontend/src/ui/EmailGate.jsx`, `frontend/src/ui/emailGateModel.js`; Modify `frontend/src/context/AuthContext.jsx` (keep the `/me` probe's JSON as `account`, expose `account` and `refreshAccount()`), `frontend/src/ui/RequireAuth.jsx` (render `<EmailGate />` instead of `<Outlet />` when the step is not `none`), `frontend/src/games/something2/src/js/net/auth.js` (`apiFetch`: a 403 whose body `error` is `email_not_verified` dispatches `something2:email-required`; AuthContext listens and calls `refreshAccount()`), `uk/react.js`; Test `frontend/src/ui/__tests__/emailGateModel.test.js`

**Produces:** `gateStep(account) -> 'loading' | 'none' | 'add' | 'verify'` — `null` ⇒ `loading`; `!emailRequired || emailVerified` ⇒ `none`; no `email` ⇒ `add`; else `verify`. `EmailGate`: full-screen overlay (nothing behind it renders), step `add` = email input + Save (`setEmail`); step `verify` = "Check your inbox — we sent a link to <email>." + Resend (disabled with countdown from `retryAfterSec`/60 s) + Change email (hidden when the server answered `email_locked`) + spam hint + Log out. Polls `refreshAccount()` on window focus.

- [ ] **Step 1: Failing tests** for `gateStep` (all four outcomes, incl. `emailRequired:false` with no email ⇒ `none`).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(auth): blocking email gate`.

### Task 14: Admin "Invites" tab

**Files:** Create `frontend/src/games/something2/InviteRequestsAdmin.jsx`, `frontend/src/games/something2/useInviteRequests.js`, `frontend/src/games/something2/inviteRequestsModel.js`; Modify `frontend/src/ui/navSections.js` (`{ id: 'invites', label: 'Invites', path: '/game/invites', Icon: HiOutlineEnvelope }` next to `board`), `frontend/src/App.jsx` (`<Route path="invites" …>` inside `<RequireAdmin />`), `frontend/src/ui/__tests__/navSections.test.js`/`navRoutes.test.js` if they enumerate entries, `uk/react.js`; Test `frontend/src/games/something2/__tests__/inviteRequestsModel.test.js`

**Produces:** hook with TanStack Query key `['invite-requests', status]`, mutations `approve(id)` / `reject(id)` invalidating it; `toast.error(errorText(code))` on failure. Model: `statusLabel(req)` (`pending`, `approved — code unused`, `approved — code used`, `rejected`), `canDecide(req)`. Layout: Pending list (email, note, requested at, Approve, Reject — buttons disabled while a mutation for that row is in flight) and History with a status filter; approved rows show the code with copy button. Styling via `--s2-*` tokens like `BoardInvites.jsx`.

- [ ] **Step 1: Failing tests** for `statusLabel`, `canDecide`; nav tests updated for the new entry.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(admin): invite requests tab`.

### Task 15: ".env sync" box in the Orange Pi tab

Owner request (2026-11-12): from the Orange Pi tab, see which project `.env` keys are passed to the board's `.env` and copy chosen ones over — this is how the mail settings reach the board. Values never reach the browser and are never printed.

**Files:**
- Create: `compose/orangepi/scripts/env-sync.sh` — sources `lib.sh`; `env-sync.sh hashes` prints one `KEY <sha256-hex of value>` line per key of the board's `.env` (hashing done ON the board over `pi_ssh`; values never leave it); `env-sync.sh write KEY` reads the value from stdin and calls `pi_env_write_key KEY replace` (refuses under `PI_LOCAL`, refuses a key not matching `^[A-Z][A-Z0-9_]*$`).
- Create: `tools/pi-helper/envSync.js` (+ `envSync.test.js`)
- Modify: `tools/pi-helper/server.js` (routes `GET /env`, `POST /env/copy`), `backend/src/api/boardRoutes.js` (proxy `GET /api/board/env`, `POST /api/board/env/copy` with typed body `{ keys: string[] }`), `backend/tests/board_routes_db.test.js` (proxy cases)
- Create: `frontend/src/games/something2/BoardEnvSync.jsx`, `useBoardEnv.js`, `boardEnvModel.js` (+ `__tests__/boardEnvModel.test.js`); Modify `BoardAdmin.jsx` (render the box beside `BoardInvites`), `uk/react.js`

**Interfaces:**
- `envSync.js`: `LOCKED_KEYS` = exact `DATABASE_URL, TEST_DATABASE_URL, REDIS_URL, CORS_ORIGINS, PUBLIC_URL, APP_URL, JWT_SECRET, TRUST_PROXY, REGISTRATION_MODE, MIGRATE_ON_BOOT, BOARD_TAB_ENABLED` plus prefixes `POSTGRES_, MINIO_, ORANGEPI_, BOARD_, PI_`; `isLocked(key) -> boolean`; `readLocalEnv(rootDir) -> Map<key,value>` (dotenv.parse of `<root>/.env`); `envStatus(runner, rootDir) -> { keys: [{ key, status: 'passed'|'not_passed'|'different'|'board_only', locked }] }` (compares local sha256 with the board's hashes; sorted by key); `copyEnvKeys(runner, rootDir, keys) -> { written: string[], skipped: [{ key, reason: 'locked'|'not_local'|'empty' }] }` — each value goes to `env-sync.sh write KEY` via the runner's `input` (stdin), never argv; board unreachable ⇒ `BoardOffline`.
- No value, and no hash, is ever in a response, log line or action-history entry (use the helper's `redact`).
- `boardEnvModel.js`: `statusLabel(status)` → `passed` "Passed", `not_passed` "Not passed", `different` "Different on board", `board_only` "Only on board"; `copyable(row)` = `!row.locked && row.status !== 'passed' && row.status !== 'board_only'`.
- UI: table of all keys (name, status badge, lock icon with tooltip "Board-specific — not copied"), checkboxes on copyable rows, filter "Hide passed", button **Copy to board** (disabled when nothing ticked / board offline), result toast listing written keys, and the note "Restart the backend on the board for changes to apply" beside the existing restart action.

- [ ] **Step 1: Failing tests:** `envSync.test.js` with a fake runner (pattern: `invites.test.js`/`testkit.js`): statuses for passed/different/not_passed/board_only; locked keys never written even if requested; value passed only via `input`, never in args; a secret value string never appears in the returned object or in any recorded log/history text; offline runner ⇒ `BoardOffline`. `boardEnvModel.test.js` for `statusLabel`, `copyable`. `board_routes_db.test.js`: proxy rejects a non-array or a key failing the regex with 400.
- [ ] **Step 2:** Run → FAIL. (`node --test tools/pi-helper/envSync.test.js`; vitest for the model; private-DB command for the board route test.)
- [ ] **Step 3:** Implement. `env-sync.sh`: `bash -n` + `shellcheck` clean.
- [ ] **Step 4:** Run → PASS. Verify `env-sync.sh` against a stub `pi_ssh` (override to run locally on a temp copy of a `.env`): `write` keeps other lines and file mode, value absent from stdout/stderr; `hashes` prints hashes only.
- [ ] **Step 5:** Commit `feat(orangepi): env sync box in the Orange Pi tab`.
- [ ] **Step 6:** Pushing to the **real board** is the owner's action from the tab (or with their explicit OK). Do not click Copy against the real board during verification.

### Task 16: Whole-branch verification

- [ ] **Step 1:** Backend full suite: `cd backend && node scripts/testdb.js run; echo EXIT=$?` against a private Postgres (AGENTS.md "Reading a test run") → `EXIT=0`, no `^not ok`.
- [ ] **Step 2:** Frontend: `cd frontend && npx vitest run; echo EXIT=$?` → `EXIT=0`.
- [ ] **Step 3:** Browser, dev stack on a private DB, **SMTP unset + `EMAIL_GATE_FORCE=1`** (console sender; Chrome with `--mute-audio`): request invite → approve in `/game/invites` → link from backend log → register → gate `verify` → link → `/login?verified=1` banner → play; forgot password → link → reset → `/login?reset=1`; old link ⇒ expired banner; existing account ⇒ `add` step. Screenshot each screen.
- [ ] **Step 4:** Gate off (unset `EMAIL_GATE_FORCE`, no SMTP): existing account logs in and plays with no popup.
- [ ] **Step 5:** **Ask the owner first**, then one real Gmail run with their `.env` to an inbox they name: verification mail arrives, renders in the game's colors, link works.
- [ ] **Step 6:** Report results; merge only on owner OK.
