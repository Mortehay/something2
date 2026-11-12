// Pure helpers for the Profile page (vitest runs in node, so the logic lives here).
import { t } from "../games/something2/src/js/i18n/i18n.js";

// Mirrors backend/src/email/templates.js maskEmail exactly: first char + *** + "@domain".
export function maskEmail(email) {
  const s = String(email || "");
  const at = s.lastIndexOf("@");
  if (at < 1) return "***";
  return `${s[0]}***${s.slice(at)}`;
}

// Which Email-section variant /me calls for.
//   no email -> 'add'; unverified -> 'verify'; verified with a change in flight -> 'pending'; else 'change'.
export function emailSectionState(account) {
  if (!account || !account.email) return "add";
  if (!account.emailVerified) return "verify";
  if (account.pendingEmail) return "pending";
  return "change";
}

export function inviteStatus(invite) {
  if (invite && invite.usedAt) return "used";
  if (invite && invite.revokedAt) return "revoked";
  return "unused";
}

// remainingToday is null for admins (unlimited), else a count.
export function canCreateInvite(remainingToday) {
  if (remainingToday === null || remainingToday === undefined) return true;
  return Number(remainingToday) > 0;
}

// A wait in seconds as user text, rounded UP to whole minutes: under an hour "{m} min",
// from 60 min on "{h} h {m} min" ("{h} h" on the hour). Null for a missing/non-positive wait.
export function formatWait(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s <= 0) return null;
  const total = Math.ceil(s / 60);
  if (total < 60) return t("{minutes} min", { minutes: total });
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return minutes
    ? t("{hours} h {minutes} min", { hours, minutes })
    : t("{hours} h", { hours });
}

// An invite's created-at as local date + time, or "" when it does not parse.
export function formatCreatedAt(iso, locale) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

// Where a dead/used confirmation link sends the user. Signed in: the Profile page (with a toast),
// because /login would bounce an authed user to /game and the "expired" banner would be lost.
export function deadLinkRoute(authed) {
  return authed ? "/game/profile" : "/login?link=expired";
}
