# Profile page — design

Date: 2026-11-12. Owner request, brainstormed in chat. Builds on the email-accounts feature
(merged on local main 0888b8c4): users.email / email_verified_at, email_tokens, mailer, link origin,
verification gate, invite codes locked to an email.

## Intent

Players need one place to manage their own account: see their name, change their email safely,
change their password, and invite friends. Today none of this exists in the app — email can only be
set once (gate pop-up) and is then locked, there is no change-password, and invite codes come only
from the operator CLI or admin approval of a request.

## Goals

- **Entry point:** the account menu under the username (top right, `frontend/src/ui/HeaderMenu.jsx`,
  where "Sign out" is) gets a **Profile** item above "Sign out". It opens a Profile page at
  `/game/profile`, available to every signed-in, verified user (not admin-only). Not in the admin
  sidebar.
- **Name:** shows the username, read-only (my call — no rename).
- **Email (owner):**
  - Shows the current email and that it is verified.
  - "Change email": enter the new address **and the current password** (my call, owner did not
    object) → the server validates the address (format, not already verified on another account,
    not the same as the current one) and mails a **confirmation link to the new address**.
  - The current email stays in force until that link is clicked; then the account's email becomes
    the new one, verified. The page shows "pending: <new> — check that inbox" with Resend and
    Cancel while a change is pending.
  - After the switch, the **old address gets a notice** "your Something2 email was changed to
    <masked new address>" (my call).
  - Link is single-use (same token model as verification), lifetime 24 hours (my call, same as
    reset links).
  - Allowed for accounts whose email came from an invite code too (the lock only fixes the email
    used at registration; my call).
- **Password (owner):** current password + new password twice → saved; every other session of the
  account is signed out (token_version bump), this session stays signed in (my call).
- **Invite codes (owner):**
  - "Create invite code" makes a code the player can send to a friend; the list shows each code
    the player created, created-at, and whether it is used and by whom (username), with Copy.
  - **Limit: 3 codes per player per day** (owner); a rolling 24 hours (my call). Admins have no limit
    (my call).
  - Codes are not tied to an email (my call); they work with the existing invite registration
    (`claimInviteCode`). Unused codes can be revoked by their creator (my call).
  - Every verified player may create codes (my call).

## Non-goals

- Username change, avatar, other profile fields.
- Admin editing other users' emails (the CLI `scripts/set-user-email.js` exists for that).
- Changing the invite-request/approval flow.

## Anti-goals

- Revealing whether an email belongs to another account beyond what the existing set-email
  endpoint already reveals (`email_taken`).
- An email change that takes effect without the new inbox confirming it, or that leaves the
  account with no working email in between.
- A stolen session silently taking over the account: email change and password change both need
  the current password.

## Constraints

- Reuse the email-accounts pieces: `email_tokens` (new purpose `change_email`), `issueEmailToken` /
  `consumeEmailToken`, `normalizeEmail`, `verifiedHolder`, `sendEmail` + templates in the project's
  colours, `linkOrigin(req)`, existing rate-limit patterns (`clientIpKey`).
- Rate limits: change-email sends share the verification cap (10 per user per hour, 60 s cooldown)
  — my call; password change attempts limited per user (e.g. 10 per 15 min) — my call.
- The confirmation link lands on a page that works whether or not the user is signed in (like
  `/verify-email/:token`), then goes to `/login?verified=1` or back to the Profile when signed in.
- Copy/text: English, matching existing tone; Ukrainian translations for player-facing strings
  (players see this page, unlike admin tabs).
- Invite codes need `created_by` (FK users, SET NULL) on `invite_codes` (migration after
  `1714440887000`).
- Tests on a private DB only; never send real mail in tests.

## Decided by the owner

Profile item in the account menu linking to a Profile page; the page shows the name, changes
email (validated by a confirmation link to the new address before it replaces the old one),
changes password, and creates invite codes for new users; 3 invite codes per day.

## My calls (owner can override)

Name read-only; current password required for email and password change; notice to the old address;
24 h single-use change link; invite-locked accounts may change email; other sessions signed out on
password change; rolling 24 h window for the 3 codes; admins unlimited; codes not tied to an email;
creator can revoke unused codes; every verified player may create codes; change-email sends share
the existing verification cap.

## Left to the builder

Exact page layout within the project's styles; route/endpoint names; how the pending change is
stored (a token row's email is enough, or a `pending_email` column).

## Settled after the builder check (my calls)

1. **Gate and email states.** `/game/profile` is behind the normal auth guard (the email gate applies
   when active, so a gated user sees the gate first). Email section by state: no email ⇒ "Add email"
   (existing set-email flow); unverified ⇒ "check your inbox" + Resend (existing); verified ⇒ Change
   email. When mail is not configured, `/me` reports `mailEnabled:false` and the change/add/resend
   actions are disabled with a note; the server refuses them with 503 `mail_disabled`.
2. **Password change** returns a freshly signed token for this session (the client stores it like a
   login); `token_version` is bumped so every other session and game socket is refused on its next
   check. This tab's game socket may reconnect with the new token; a brief reconnect is acceptable.
3. **Invite cap:** revoke is soft (`revoked_at`); revoked codes still count toward 3 per rolling 24 h
   and can no longer be claimed. Create runs in a transaction with a per-user advisory lock so
   concurrent clicks cannot exceed the cap.
4. **Applying a change:** on confirm, if another account verified that address meanwhile ⇒ 409
   `email_taken`, the token is spent (the user requests again). On success: email replaced and
   verified, the user's pending `verify_email` and `reset_password` tokens are invalidated, the old
   address gets the notice. No token_version bump (the change already needed the password).
5. **Schema:** one migration after `1714440887000`: widen `email_tokens.purpose` CHECK with
   `change_email`; `invite_codes.created_by` (FK users SET NULL) and `revoked_at`. The pending new
   address lives only on the `change_email` token row (`email`); re-requesting replaces it
   (`issueEmailToken` revokes older ones); Cancel marks it used.
6. **Player codes** are not tied to an email; any holder registers with any email; same generator.
   Admin UI unchanged; the invite CLI `list` shows the creator's username.
7. **Translations:** the app has `t()` with the Ukrainian dictionary
   `frontend/src/games/something2/src/js/i18n/uk/react.js`; every Profile/confirm-page string gets an
   entry. Emails stay English (no stored user language).
8. **Confirm page:** new route `/confirm-email/:token` outside the auth guard. It peeks the token on
   load and shows the new address with a **Confirm** button (POST consumes; never consume on GET —
   mail scanners prefetch links). Signed in ⇒ `/game/profile` with a "Email changed" notice; signed
   out ⇒ `/login?verified=1`. Dead link ⇒ `/login?link=expired`.
