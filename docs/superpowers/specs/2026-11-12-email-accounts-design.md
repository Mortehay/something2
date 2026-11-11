# Email accounts: invite requests, verification, password reset — design

Date: 2026-11-12. Status: draft for owner approval (builder check done; gate rollout decided: option A).

## Why

Today `/login` offers only "Sign in" and "Create account", and on the Orange Pi
board (`REGISTRATION_MODE=invite`) creating an account needs an invite code the
operator hands over out-of-band. There is no way for a stranger to ask for a
code, and no way to recover a forgotten password — accounts have no email.

This adds email to every account and builds three flows on it:

1. **Request an invite** from the login page; an admin approves or rejects it in
   a new admin tab, and the requester is emailed either way.
2. **Email verification**, mandatory for every account, old and new. Unverified
   accounts cannot play.
3. **Forgot password** via a single-use emailed link.

## Goals

- Login page gets two new links: **Request invite code** and **Forgot password**.
- Every account has a verified email before it can play.
- An admin can see invite requests in `/game/invites` and approve or reject them;
  each decision is emailed to the requester.
- All email links are single-use, unguessable (random UUID v4 token), expiring.
- Email goes out through Gmail SMTP; swapping provider later is an `.env` change.
- Emails look like the game: project colors, short, plain.

## Non-goals

- No domain of our own, no Mailjet (owner chose Gmail SMTP; the free
  `something2.work.gd` domain and Mailjet keys in `.env` are unused by this).
- No changing username, no account deletion, no "change email" for an already
  verified account (beyond what the verification popup offers before verifying).
- No marketing/notification emails. Only: invite approved, invite rejected,
  verify email, reset password.
- No replacing the existing invite-code machinery or the Orange Pi tab's
  "Invite codes" box — they keep working as they do.

## Anti-goals (a failure even if it "works")

- **The client alone enforces the verification gate.** The backend must refuse an
  unverified account for game access, including the authority WebSocket upgrade
  in `backend/src/authority/server.js`, not just hide `/game` in React.
- **Account enumeration.** Request-invite and forgot-password answer identically
  whether or not the email is known/registered/pending.
- **Link host taken from an untrusted header.** A reset link built from whatever
  `Origin`/`Host` the request carried lets an attacker request a reset for a
  victim with `Origin: https://evil.example` and harvest the token. See
  "Link address" below.
- **A token usable twice**, or a token stored in plaintext such that a DB read
  hands out working links (store a hash; see Data).
- **Tests send real email.** No SMTP config ⇒ console sender; the suite never
  reaches Gmail.
- **Logging secrets.** Never log `req.body`, tokens, or `SMTP_PASS`
  (`backend/src/auth/routes.js` already follows this for passwords/invite codes).

## Constraints from the project

- Backend is Express + raw `pg` + node-pg-migrate (`backend/migrations/`).
  Migration timestamps collide in this repo regularly — pick the timestamp
  against the tree, not by guessing.
- Auth today: `backend/src/auth/routes.js` (`/register`, `/login`, `/me`,
  `/logout-all`), JWT with `token_version` revocation, shared check
  `currentUserForToken` in `backend/src/auth/tokens.js` used by both HTTP
  (`middleware.js`) and the WS upgrade. A verification check belongs at the same
  single point so the two transports cannot diverge (the comment in `tokens.js`
  explains why that matters).
- `users.username` is `citext`; email should be `citext` + unique too.
- Invite codes: table `invite_codes` (`code`, `note`, `used_at`, `used_by`),
  generator `mintCode()` in `backend/scripts/invite-codes.js`, claim logic in
  `backend/src/auth/inviteCodes.js` (single conditional UPDATE — keep that).
  `REGISTRATION_MODE` is `open` in dev, `invite` on the board.
- Rate limiting: `express-rate-limit` with `clientIpKey` (`backend/src/clientIp.js`).
- Frontend: React 19, styled-components, TanStack Query, routes in
  `frontend/src/App.jsx`. Admin tabs are routes under `GameShell` wrapped in
  `<RequireAdmin />`; `GameShell` must stay a layout route. UI strings go through
  `t()` (`frontend/src/games/something2/src/js/i18n/`), which has a `uk` locale.
- The game is served on `localhost:15173` in dev and through ngrok / a Cloudflare
  quick tunnel whose public address changes several times a day. `make tunnel`
  adds the tunnel origin to `CORS_ORIGINS`.
- Never mutate the shared dev DB from tests; backend suite is
  `node scripts/testdb.js run` (see AGENTS.md).

## Email sending (decided)

- **Gmail SMTP with an app password**, via `nodemailer`, `smtp.gmail.com:587`
  STARTTLS. Owner has set in `.env`: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
  `SMTP_PASS`, `MAIL_FROM`. A login test against Gmail succeeded on 2026-11-12.
- `SMTP_PASS` is stored with the spaces Google displays — strip whitespace before use.
- One helper, e.g. `sendEmail({ to, subject, text, html })`. If `SMTP_HOST` is
  unset (tests, a dev without keys) it logs the email (recipient, subject, and the
  link) to the console instead and reports success.
- The SMTP vars must be passed to the backend container in
  `compose/develop/docker-compose.yml` (backend `environment:` or confirm the
  mounted `.env` + `dotenv` already exposes them) and listed in `.env.example`
  with blank values. The orangepi compose gets the same names; deploying is not
  part of this work.
- Gmail limit is ~500 recipients/day; irrelevant at this volume, but a send
  failure must surface (see admin approve) rather than be swallowed.

## Email templates

Four emails: **invite approved** (contains the code and a link to the register
form), **invite rejected**, **verify your email** (link), **reset your password**
(link). Each has a plain-text part and an HTML part.

HTML uses the login page's palette (`frontend/src/pages/Login.jsx`): page
`#0f0f1a`, card `#1a1a2e` with `#2e2e3e` border, white heading, muted body text,
button `#4a9eff`. Email-client-safe HTML: tables + inline styles, no external
CSS, no images, no web fonts, and the link also printed as plain text under the
button. Footer: "If you didn't ask for this, ignore this email." Templates live
in one backend module so wording and colors change in one place.

Language: English for now (my call — emails are sent before we know a UI
language preference for invite requests; can follow the UI language later).

## Link address

Links in emails are `<origin>/verify-email/<token>`, `<origin>/reset-password/<token>`,
`<origin>/login?register=1&invite=<code>` (invite approved).

`<origin>` is the browser origin the request came from **only if it is in the
allowlist** — the existing `CORS_ORIGINS` list plus an optional `APP_URL`. A
request whose origin is not allowlisted gets the `APP_URL` fallback, or if that is
unset the first `CORS_ORIGINS` entry. Same-origin production (Caddy, no `Origin`
on some requests): fall back to `APP_URL`.

**Same-origin requests are also trusted** (my call): when the request's `Origin`
host equals its `Host` header, that origin is used. This is what makes the Orange
Pi board work — it is served from one origin behind Caddy and a cloudflared quick
tunnel whose hostname changes on every restart, so `CORS_ORIGINS` is empty there
and no fixed `APP_URL` exists. Why this is safe enough: through the tunnel,
Cloudflare routes by hostname, so a request carrying a forged `Host` never reaches
the board; a forged `Origin` that differs from `Host` is not trusted. If neither
rule yields an origin the endpoint refuses to send (error to the caller, logged)
rather than mail a link to a wrong host.

For the admin **approve/reject** emails the origin is the admin's current origin
(same allowlist rule) — the admin is on the address players use.

Known limitation, accepted: if the tunnel address changes between sending and
clicking, the link points at a dead host. The user requests a new one.

## Data

- `users.email citext NULL`, `users.email_verified_at timestamptz NULL`.
  Nullable because existing rows have none. "Verified" = `email_verified_at IS NOT NULL`.
- Uniqueness (my call): a **partial unique index over verified emails only**. An
  unverified claim never blocks the real owner: registering or setting an email
  is refused only if a *verified* account holds it; verifying fails with
  "already used by another account" if another account verified it first.
  "Registered" in request-invite means "held by a verified account".
- `invite_requests`: id, `email citext`, `note text` (≤300), `status`
  (`pending` | `approved` | `rejected`), `created_at`, `decided_at`, `decided_by`
  (user id), `invite_code` (FK to `invite_codes.code`, set on approve).
  At most one `pending` row per email (partial unique index).
- `invite_codes.email citext NULL` — set when minted for a request; when set,
  registration with that code must use that email.
- `email_tokens`: `token_hash` (sha256 of the UUID, PK), `user_id`, `purpose`
  (`verify_email` | `reset_password`), `email` (the address it was sent to),
  `expires_at`, `used_at`, `created_at`. Issuing a new token of a purpose for a
  user invalidates that user's earlier unused tokens of the same purpose.
  Consuming = one conditional `UPDATE … SET used_at = now() WHERE token_hash = $1
  AND used_at IS NULL AND expires_at > now() RETURNING …` (same race-proof pattern
  as `claimInviteCode`).
- Expiry: verify-email 24 h, reset-password 1 h (my call).

## Flows

### Login page (`/login`)

Two new links under the form: **Request invite code**, **Forgot password?** Each
opens its own small form in the same card style (route or in-card view —
builder's choice).

`/login` also shows a one-time banner from a query flag after redirects:
"Your email is verified — you can sign in", "Password changed — sign in with the
new one", "This link was already used or has expired — request a new one".

### Request invite

- Fields: email (required), note "Why do you want to join?" (optional, ≤300).
- Always answers "Request received. If it's approved you'll get a code by email.
  Not there? Check your spam folder." — whether new, already pending, or already
  a registered email. Already pending ⇒ no new row. Registered ⇒ no row.
- Rate-limited per IP (my call: 5 per hour).
- A **rejected** email cannot request again for 7 days (my call); during that
  time it gets the same "request received" answer and no new row.
- Shown in every `REGISTRATION_MODE` except `closed`? — **my call: shown only
  when mode is `invite`**; in `open` mode the link is hidden (anyone may register),
  in `closed` hidden. The frontend learns the mode from a small public endpoint
  or from the register form's existing behaviour — builder's choice.

### Admin "Invites" tab (`/game/invites`, admin only)

- New sidebar entry and route under `<RequireAdmin />`.
- **Pending** list: email, note, requested at; buttons **Approve**, **Reject**.
- **Approve**: in one transaction mint a code (reuse `mintCode()` — move it to a
  shared module rather than duplicating), set `invite_codes.email` and
  `note = "request <id>"`, mark request approved; send the "approved" email. If
  the send fails: roll back (request stays pending, code not created) and show
  the error. On success the row shows the code (fallback if the mail lands in spam).
- **Reject**: mark rejected, send the "rejected" email. If the send fails the
  request stays pending and the error shows.
- **History** below: approved/rejected, who decided, when, the code and whether
  it was used. Filter by status (my call).
- Codes made in the Orange Pi tab are unaffected and still register without an
  email lock.

### Registration

- Fields: username, **email (required)**, password, invite code (when mode is
  `invite`). The approved-invite link pre-fills code and email.
- Email must be unused (case-insensitive). If the invite code has an `email`,
  the submitted email must match it.
- Registration succeeds, the account is created **unverified**, a verification
  email is sent, and the user lands in the verification popup (below). Applies in
  every registration mode.
- If the verification email fails to send the account still exists; the popup's
  Resend handles it.
- An account registered with an email-locked code cannot use **Change email** in
  the gate popup (my call) — otherwise the lock means nothing. It can only Resend.

### Verification gate (all accounts, admins included)

After login (and on any app load with a stored token), `/me` reports `email` and
`emailVerified`. If not verified, the whole app is covered by a blocking modal —
nothing behind it is interactive and `/game` and its tabs do not render:

1. **No email yet** (existing accounts): "Add your email" — one input, Save.
   Uniqueness enforced; duplicate ⇒ "This email is already used by another account".
2. **Email set, not verified**: "Check your inbox — we sent a link to <email>."
   Buttons: **Resend** (60 s cooldown, server-enforced too), **Change email**
   (back to step 1; issues a new token, old ones die). Spam hint. **Log out** link.

**When the gate is active (owner decision, 2026-11-12):** only when SMTP is
configured (`SMTP_HOST` set, plus user/pass). Without it the game behaves as today
— no gate, no blocking popups — so a merge that auto-deploys to the board before
its `.env` has the Gmail settings locks nobody out. Adding the settings and
restarting the backend switches the gate on for everyone. The console sender
still works for flows that send mail (request invite, register, forgot password)
when SMTP is unset, but nothing blocks play. The frontend learns whether the gate
is active from `/me` (e.g. `emailRequired`), never decides it itself. Tests can
force the gate on without real SMTP (a test-only switch or injected config).

Server side (when active): unverified accounts may only call `/me`, logout, set-email, resend.
Every other authenticated API and the authority WS upgrade refuse them
(403 `email_not_verified`). Put the check where `currentUserForToken` /
`authenticate` already sit, with an explicit allowlist for the gate endpoints —
the builder picks the exact mechanism, but there must be one place, covering both
transports.

Owner note: admins are gated too, so the first thing after deploy is the admin
verifying their own email — with SMTP configured this is one click.

Already-open game sockets: the WS authority runs inside the backend process, so
the deploy restart drops every socket and reconnects hit the gate. No forced
disconnect needed.

**Operator escape hatch** (my call): extend `backend/scripts/set-admin-password.js`
(or a sibling CLI) with `--email <addr>` that sets the email **and marks it
verified**. This covers the bootstrap admin, the script/service logins
(`gen-sprites.js`, `spriteRunnerClient.js` log in as `SOMETHING2_ADMIN_USER`), and
recovery when SMTP is broken.

### Verify-email link

`GET`-landing page `/verify-email/:token` (frontend) calls the backend to consume
the token; on success sets `email_verified_at` (only if the token's `email` still
equals the account's email), then redirects to `/login?verified=1`, which shows the
one-time "email verified" banner. Used/expired/unknown ⇒ `/login?link=expired`.
The page works whether or not the browser is logged in. If it is logged in, the
token stays valid; on the next `/me` the gate disappears.

### Forgot password

- Form: email. Always answers "If that email belongs to an account, a reset link
  is on its way. Check spam too." Sends to the account's email whether verified
  or not (my call — otherwise someone who never verified and forgot the password
  is locked out forever). Using a reset link **also verifies** that email, since
  it proves the inbox is theirs. If several unverified accounts claim the same
  address, it sends nothing (ambiguous) unless exactly one account holds it.
- Rate-limited per IP and per email (my call: 3 per hour per email).
- `/reset-password/:token`: new password + repeat, same rules as registration.
  On submit: consume token, set new hash, bump `token_version` (logs out every
  session), redirect to `/login?reset=1`.
- Opening the page with a dead token shows the expired message immediately (the
  backend offers a cheap "is this token live" check that does not consume it).

## UI

All new screens reuse the login card look (`Screen`/`Card`/`Field`/button styles
from `Login.jsx` — extract shared pieces instead of copying). All strings via
`t()` with `uk` translations added. The admin tab follows existing admin tab
styling (`--s2-*` tokens, like `BoardInvites.jsx`).

## Testing expectations

- Backend: token issue/consume (single use under a race, like the invite-claim
  test), expiry, invalidation on reissue; enumeration-safe responses; gate
  refusing an unverified token on HTTP **and** WS; approve rollback on send
  failure (fake sender); registration email-lock for request-minted codes.
- Frontend: vitest for the pure models; browser verification of the full loop
  on the dev stack with the console sender (and once with real Gmail to an
  owner-chosen inbox, with permission).

## Left to the builder

- Route/endpoint names and request shapes.
- Whether the login sub-forms are routes or in-card views.
- How the frontend learns `REGISTRATION_MODE`.
- Admin tab layout details, history filter UI.
- Exact rate-limit numbers within the spirit above.

## My calls (owner, please check)

1. Request-invite link shown only in `invite` mode.
2. Token expiry: verify 24 h, reset 1 h. Resend cooldown 60 s.
3. Tokens stored hashed; link carries the raw UUID.
4. Password reset logs out all sessions.
5. Codes minted from a request are locked to that email.
6. Emails in English only for now.
7. Approve/reject roll back if the email can't be sent.
8. Admins are gated by verification like everyone else.
9. Same-origin requests (`Origin` host = `Host`) are trusted for link building — needed for the board's changing tunnel hostname.
10. Email uniqueness counts only verified emails.
11. Rejected emails can't re-request for 7 days.
12. Accounts registered with an email-locked code can't change email before verifying.
13. Forgot-password also works for unverified emails, and a used reset link verifies the email.
14. A CLI flag sets and verifies an account's email without SMTP.

## Addendum 2026-11-12: ".env sync" in the Orange Pi tab (owner request)

The mail settings reach the board through a new box in the Orange Pi tab
(`/game/board`). It lists **every** key of the project `.env` and the board's
`.env` with a status: **Passed** (same value on both), **Not passed** (missing on
the board), **Different on board**, **Only on board**. The admin ticks keys and
clicks **Copy to board**; the workstation helper writes them into the board's
`.env` with the same safe writer the deploy uses (`pi_env_write_key`).

- Values never reach the browser and are never printed or logged; comparison
  uses hashes computed on each side, and only statuses cross to the UI.
- Board-specific keys are locked and cannot be copied (my call): database,
  Redis, CORS/public URLs, JWT secret, proxy/registration/migration settings and
  the `POSTGRES_`, `MINIO_`, `ORANGEPI_`, `BOARD_`, `PI_` families.
- Copying does not restart anything; the box points at the existing restart action.
