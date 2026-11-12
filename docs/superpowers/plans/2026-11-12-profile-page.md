# Profile Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Profile page (account menu → `/game/profile`) where a player sees their name, changes their email via a confirmation link to the new address, changes their password, and creates up to 3 invite codes per day.

**Architecture:** New backend route file for profile actions on top of the email-accounts primitives (`email_tokens` with a new `change_email` purpose, mailer, link origin); one migration widens the token purpose and adds `created_by`/`revoked_at` to `invite_codes`. Frontend: a Profile page with three sections, a confirm page for the emailed link, and a menu item.

**Tech Stack:** Express + raw pg + node-pg-migrate (CJS), node:test + supertest; React 19 + styled-components + TanStack Query; vitest (node env, pure models).

**Spec:** `docs/superpowers/specs/2026-11-12-profile-page-design.md`

## Global Constraints

- Change email needs the current password; the confirmation link goes to the NEW address; the old email stays until confirmed; after the switch the old address gets a notice with the new address masked (`a***@example.com`).
- Change link: purpose `change_email`, single use, 24 h (`CHANGE_EMAIL_TTL_MS = 24 * 3600e3`), never consumed on GET.
- Change-email sends share the verification cap: 60 s cooldown + 10 per user per hour (`sendThrottleSec` in `accountEmailRoutes.js`, extended to count `change_email` too).
- Password change: current + new; new must differ from current and be non-empty; bumps `token_version`; returns a new token for this session. Limit 10 attempts per user per 15 min ⇒ 429 `too_many_requests`.
- Invite codes: 3 per user per rolling 24 h (revoked ones count); admins unlimited; soft revoke (`revoked_at`), revoked codes can't be claimed; creation under a per-user advisory lock in a transaction.
- Mail not configured (`smtpConfigured()` false) ⇒ email actions answer 503 `mail_disabled`; `/me` gains `mailEnabled: boolean`.
- Error codes (new): `wrong_password`, `same_email`, `mail_disabled`, `invite_limit`, `not_found`; existing: `invalid_email`, `email_taken`, `link_expired`, `too_many_requests`, `resend_cooldown`.
- Copy: menu item `Profile`; page title `Profile`; sections `Name`, `Email`, `Password`, `Invite codes`; buttons `Change email`, `Change password`, `Create invite code`, `Copy`, `Revoke`, `Confirm`; Ukrainian entries in `frontend/src/games/something2/src/js/i18n/uk/react.js` for every new `t()` string. Emails English.
- Migration timestamp `1714440888000`.
- Tests on a private DB only (AGENTS.md "Reading a test run"); never real mail; never the shared dev DB.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Confirm link opened after another account verified the same address → 409 `email_taken`, account email unchanged, token spent. (Task 2 test `confirm loses to a newer verified holder`.)
2. Old reset link used after an email change → refused. (Task 2 test `change invalidates pending reset and verify tokens`.)
3. Password change from one tab → another tab's next API call is 401, this tab keeps working with the new token. (Task 3 test `other sessions signed out, returned token works`.)
4. Two concurrent "Create invite code" clicks at 2 of 3 used → exactly one succeeds. (Task 4 test `concurrent creates respect the cap`.)
5. A revoked code used at registration → refused with the existing invalid/used-code error. (Task 4 test `revoked code cannot register`.)

---

### Task 1: Migration + token purpose

**Files:** Create `backend/migrations/1714440888000_profile.js`; Modify `backend/src/auth/emailTokens.js` (export `CHANGE_EMAIL_TTL_MS`), `backend/src/auth/inviteCodes.js` (claim excludes `revoked_at IS NOT NULL`), `backend/scripts/invite-codes.js` (`list` shows creator username); Test `backend/tests/profile_schema_db.test.js`

**Interfaces — Produces:** `email_tokens.purpose` CHECK allows `change_email`; `invite_codes.created_by integer NULL FK users ON DELETE SET NULL`, `invite_codes.revoked_at timestamptz NULL`, index `(created_by, created_at)`; `CHANGE_EMAIL_TTL_MS`.

- [ ] **Step 1: Failing tests:** insert an `email_tokens` row with purpose `change_email` succeeds, `bogus` fails 23514; `invite_codes` has `created_by` and `revoked_at`; `claimInviteCode` returns false for a revoked unused code; down migration restores the old CHECK.
- [ ] **Step 2–4:** private DB FAIL → implement → PASS (plus `tests/invite_codes_cli_db.test.js`, `tests/invite_codes_db.test.js`).
- [ ] **Step 5:** Commit `feat(profile): schema for email change and player invite codes`.

### Task 2: Change email (request, confirm, cancel)

**Files:** Create `backend/src/auth/profileRoutes.js` (mounted under `/api/auth` next to accountEmailRoutes), `backend/tests/profile_email_db.test.js`; Modify `backend/src/email/templates.js` (`changeEmailEmail({ link })`, `emailChangedNoticeEmail({ maskedNew })`), `backend/src/auth/accountEmailRoutes.js` (`sendThrottleSec` counts `verify_email` + `change_email`), `backend/src/auth/routes.js` (`/me` adds `mailEnabled`, and `pendingEmail` = the live change token's email or null)

**Interfaces — Produces:**
- `POST /api/auth/email/change {email, password}` (auth) ⇒ 200 `{ pendingEmail }`; 400 `invalid_email`; 400 `same_email`; 403 `wrong_password`; 409 `email_taken` (verified elsewhere); 429 `resend_cooldown` + `retryAfterSec`; 503 `mail_disabled`; 500 `no_link_origin`. Mails `changeEmailEmail` with link `${origin}/confirm-email/${token}`.
- `POST /api/auth/email/change/cancel` (auth) ⇒ 200 `{ ok:true }` (live change token marked used).
- `GET /api/auth/email/change/:token` (public) ⇒ `{ live, email }` (email of the pending address only when live).
- `POST /api/auth/email/change/confirm {token}` (public) ⇒ 200 `{ ok:true }`; 410 `link_expired`; 409 `email_taken`. On success, in one transaction: consume token, set `users.email` = token email and `email_verified_at = now()`, invalidate the user's unused `verify_email` and `reset_password` tokens; after COMMIT, mail `emailChangedNoticeEmail` to the OLD address (failure logged, not surfaced).
- Allowlisted for unverified users: none (profile requires a verified account when the gate is active).

- [ ] **Step 1: Failing tests:** happy path (request ⇒ mail to new address with `/confirm-email/` link, `/me.pendingEmail` set, email unchanged; confirm ⇒ email switched + verified, notice mailed to old address with masked new); wrong password 403 and no mail; same email 400; invalid 400; taken 409; cooldown 429 shared with resend; mail disabled 503; cancel ⇒ confirm 410; GET on token never consumes; `confirm loses to a newer verified holder`; `change invalidates pending reset and verify tokens`; second request replaces the first (first link 410).
- [ ] **Step 2–4:** FAIL → implement → PASS on the private DB (also `account_email_routes_db`, `auth_email_gate`).
- [ ] **Step 5:** Commit `feat(profile): change email with a confirmation link`.

### Task 3: Change password

**Files:** Modify `backend/src/auth/profileRoutes.js`; Test `backend/tests/profile_password_db.test.js`

**Interfaces — Produces:** `POST /api/auth/password/change {currentPassword, newPassword}` (auth) ⇒ 200 `{ token }` (signed with the bumped `token_version`); 403 `wrong_password`; 400 `password is required` (empty new) / `same_password`; 429 `too_many_requests` after 10 per user per 15 min.

- [ ] **Step 1: Failing tests:** `other sessions signed out, returned token works` (old token ⇒ 401 on `/me`, new token ⇒ 200; login with new password works, old fails); wrong current 403 and no change; same password 400; limiter 11th ⇒ 429 (own app).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(profile): change password`.

### Task 4: Player invite codes

**Files:** Modify `backend/src/auth/profileRoutes.js`; Test `backend/tests/profile_invites_db.test.js`

**Interfaces — Produces:**
- `GET /api/auth/invites` ⇒ `{ invites: [{ code, createdAt, usedAt, usedBy (username|null), revokedAt }], remainingToday: number|null }` (null for admins) newest first, only the caller's.
- `POST /api/auth/invites` ⇒ 201 `{ invite }`; 429 `invite_limit` + `retryAfterSec` (when the oldest of the last 3 leaves the 24 h window).
- `POST /api/auth/invites/:code/revoke` ⇒ 200 `{ invite }`; 404 `not_found` for someone else's or unknown code; 409 `already_used`.
- Codes from `inviteCodeGen.js` `mintCode`, `note = 'player <username>'`, `created_by` = caller.

- [ ] **Step 1: Failing tests:** 3 creates ok, 4th 429 with retryAfterSec; revoked still counts; `concurrent creates respect the cap` (Promise.all of 2 at 2 used ⇒ one 201, one 429); admin unlimited (`remainingToday` null); list shows only own codes and the user who used one; `revoked code cannot register` via `/api/auth/register` in invite mode; revoke someone else's ⇒ 404; revoke used ⇒ 409.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(profile): players create invite codes`.

### Task 5: Frontend — Profile page, confirm page, menu item

**Files:** Create `frontend/src/pages/Profile.jsx` (or under `games/something2/` following where game pages live), `frontend/src/pages/ConfirmEmail.jsx`, `frontend/src/pages/profileModel.js`, `frontend/src/pages/__tests__/profileModel.test.js`; Modify `frontend/src/games/something2/src/js/net/accountApi.js` (changeEmail, cancelEmailChange, peekEmailChange, confirmEmailChange, changePassword, listInvites, createInvite, revokeInvite), `frontend/src/ui/HeaderMenu.jsx` (`Profile` item above `Sign out`), `frontend/src/App.jsx` (`/game/profile` under RequireAuth, not RequireAdmin; `/confirm-email/:token` outside the auth guard), `frontend/src/pages/loginModel.js` (`errorText` for new codes), `uk/react.js`

**Interfaces — Consumes:** Task 2–4 endpoints; `/me` `mailEnabled`, `pendingEmail`; AuthContext `signIn(token)` to store the new token after a password change; `refreshAccount`.
**Produces:** `profileModel.js`: `maskEmail(email) -> string` (`a***@example.com`; mirror the backend mask), `emailSectionState(account) -> 'add'|'verify'|'pending'|'change'`, `inviteStatus(invite) -> 'unused'|'used'|'revoked'`, `canCreateInvite(remainingToday) -> boolean`.

- [ ] **Step 1: Failing tests** for the model functions (all branches) and `errorText` for each new code.
- [ ] **Step 2–4:** FAIL → implement → PASS; full vitest (pre-existing reds passiveNodeForm, skillsHotbar only); eslint changed files; `npx vite build`.
- UI: Name (read-only); Email by state (add / verify+resend / pending with Resend+Cancel / verified with Change email form: new email + current password; disabled with a note when `mailEnabled` is false); Password form (current, new, repeat; repeat must match client-side; on success store returned token, toast); Invite codes (Create button with `remainingToday` left, list with Copy for unused, Revoke, used-by name). Confirm page: peek on load ⇒ show new address + **Confirm**; success ⇒ signed in `/game/profile` with "Email changed" notice, signed out `/login?verified=1`; dead ⇒ `/login?link=expired`. Existing authCard / `--s2-*` styles.
- [ ] **Step 5:** Commit `feat(profile): profile page`.

### Task 6: Whole-branch verification

- [ ] **Step 1:** Backend full suite on a private DB; compare with the known pre-existing failures on main — no new ones.
- [ ] **Step 2:** Frontend full vitest; vite build.
- [ ] **Step 3:** Browser on a private stack (console mailer, `EMAIL_GATE_FORCE=1`, muted Chrome): menu → Profile; change email → link from the log → Confirm → switched + notice in the log; password change in tab A ⇒ tab B signed out; create 3 codes, 4th refused; register with a code; revoke; old reset link refused after the change. Screenshots.
- [ ] **Step 4:** Report; merge only on owner OK.
