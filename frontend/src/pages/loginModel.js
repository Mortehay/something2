// Pure helpers for the login page: query-string banners, register prefill and
// server error code -> user text. No DOM, so vitest (node env) covers them.
import { t } from "../games/something2/src/js/i18n/i18n.js";

const BANNERS = [
  ["verified", "1", "ok", "Your email is verified — you can sign in"],
  ["reset", "1", "ok", "Password changed — sign in with the new one"],
  ["link", "expired", "error", "This link was already used or has expired — request a new one"],
];

// First matching banner for the query string, or null.
export function loginBannerFor(searchParams) {
  if (!searchParams || typeof searchParams.get !== "function") return null;
  for (const [key, value, kind, text] of BANNERS) {
    if (searchParams.get(key) === value) return { kind, text: t(text) };
  }
  return null;
}

// ?register=1&invite=CODE&email=a%40b.co opens the register form prefilled.
export function registerPrefill(searchParams) {
  const get = (k) => (searchParams && typeof searchParams.get === "function" ? searchParams.get(k) : null);
  return {
    register: get("register") === "1",
    invite: get("invite") || "",
    email: get("email") || "",
  };
}

// Server `error` code (or plain-string message) -> user text. Written so no
// message says whether an email or account exists beyond what the server
// already answers for that route.
const TEXT = {
  email_not_verified: "Verify your email first — check your inbox (and spam) for the link",
  email_taken: "That email is already used by another account",
  email_locked: "This email is fixed for your account and can't be changed",
  link_expired: "This link was already used or has expired — request a new one",
  email_failed: "We couldn't send the email right now — please try again later",
  no_link_origin: "The server can't build a link for this address — contact an admin",
  invalid_email: "Enter a valid email address",
  not_pending: "That request was already handled",
  too_many_requests: "Too many attempts — please wait a while and try again",
  unauthorized: "Please sign in again",
  misconfigured: "The server is misconfigured — contact an admin",
  "invalid credentials": "Wrong username or password",
  "username is taken": "That username is taken",
  "an invite code is required": "An invite code is required",
  "registration is closed": "Registration is closed",
  "invalid or already-used invite code": "That invite code is invalid or already used",
  "username and password are required": "Enter a username and a password",
  "password is required": "Enter a new password",
  wrong_password: "That password is wrong",
  same_email: "That is already your email",
  same_password: "The new password must differ from the current one",
  mail_disabled: "Email isn't set up on this server",
  invite_limit: "You've used all your invite codes for now",
  not_found: "That code no longer exists",
  already_used: "That code was already used",
};

const FALLBACK = "Something went wrong — please try again";

export function errorText(code, retryAfterSec) {
  if (code === "resend_cooldown") {
    const s = Number(retryAfterSec);
    return Number.isFinite(s) && s > 0
      ? t("Please wait {seconds}s before asking for another email", { seconds: Math.ceil(s) })
      : t("Please wait a moment before asking for another email");
  }
  if (code === "invite_limit") {
    const s = Number(retryAfterSec);
    if (Number.isFinite(s) && s > 0) {
      return t("You've used all your invite codes — the next one frees up in {minutes} min", { minutes: Math.ceil(s / 60) });
    }
  }
  const text = Object.prototype.hasOwnProperty.call(TEXT, code) ? TEXT[code] : FALLBACK;
  return t(text);
}
