import { describe, it, expect } from "vitest";
import {
  maskEmail, emailSectionState, inviteStatus, canCreateInvite, formatWait, formatCreatedAt, deadLinkRoute,
} from "../profileModel.js";
import { errorText } from "../loginModel.js";

describe("maskEmail", () => {
  it("keeps the first char and the domain", () => {
    expect(maskEmail("alice@example.com")).toBe("a***@example.com");
  });
  it("uses the last @", () => {
    expect(maskEmail("a@b@example.com")).toBe("a***@example.com");
  });
  it("falls back to *** without a local part", () => {
    expect(maskEmail("@example.com")).toBe("***");
    expect(maskEmail("nope")).toBe("***");
    expect(maskEmail("")).toBe("***");
    expect(maskEmail(null)).toBe("***");
  });
});

describe("emailSectionState", () => {
  it("add when there is no email", () => {
    expect(emailSectionState({ email: null })).toBe("add");
    expect(emailSectionState({ email: "" })).toBe("add");
    expect(emailSectionState(null)).toBe("add");
  });
  it("verify when unverified, even with a pending change", () => {
    expect(emailSectionState({ email: "a@b.co", emailVerified: false })).toBe("verify");
    expect(emailSectionState({ email: "a@b.co", emailVerified: false, pendingEmail: "c@d.co" })).toBe("verify");
  });
  it("pending when verified with a pending change", () => {
    expect(emailSectionState({ email: "a@b.co", emailVerified: true, pendingEmail: "c@d.co" })).toBe("pending");
  });
  it("change when verified and nothing pending", () => {
    expect(emailSectionState({ email: "a@b.co", emailVerified: true, pendingEmail: null })).toBe("change");
    expect(emailSectionState({ email: "a@b.co", emailVerified: true })).toBe("change");
  });
});

describe("inviteStatus", () => {
  it("used wins over revoked", () => {
    expect(inviteStatus({ usedAt: "2026-01-01", revokedAt: "2026-01-02" })).toBe("used");
    expect(inviteStatus({ usedAt: "2026-01-01", revokedAt: null })).toBe("used");
  });
  it("revoked", () => expect(inviteStatus({ usedAt: null, revokedAt: "2026-01-02" })).toBe("revoked"));
  it("unused", () => expect(inviteStatus({ usedAt: null, revokedAt: null })).toBe("unused"));
});

describe("canCreateInvite", () => {
  it("null means unlimited", () => {
    expect(canCreateInvite(null)).toBe(true);
    expect(canCreateInvite(undefined)).toBe(true);
  });
  it("needs at least one left", () => {
    expect(canCreateInvite(3)).toBe(true);
    expect(canCreateInvite(1)).toBe(true);
    expect(canCreateInvite(0)).toBe(false);
  });
});

describe("errorText for profile codes", () => {
  const cases = {
    wrong_password: "That password is wrong",
    same_email: "That is already your email",
    same_password: "The new password must differ from the current one",
    mail_disabled: "Email isn't set up on this server",
    invite_limit: "You've used all your invite codes for now",
    not_found: "That code no longer exists",
    already_used: "That code was already used",
    email_failed: "We couldn't send the email right now — please try again later",
  };
  for (const [code, text] of Object.entries(cases)) {
    it(code, () => expect(errorText(code)).toBe(text));
  }
  it("invite_limit with a wait names the time", () => {
    expect(errorText("invite_limit", 3600)).toBe("You've used all your invite codes — the next one frees up in 1 h");
    expect(errorText("invite_limit", 86340)).toBe("You've used all your invite codes — the next one frees up in 23 h 59 min");
    expect(errorText("invite_limit", 90)).toBe("You've used all your invite codes — the next one frees up in 2 min");
    expect(errorText("invite_limit", 0)).toBe("You've used all your invite codes for now");
  });
});

describe("formatWait", () => {
  it("under an hour is whole minutes, rounded up", () => {
    expect(formatWait(1)).toBe("1 min");
    expect(formatWait(90)).toBe("2 min");
    expect(formatWait(3540)).toBe("59 min");
    expect(formatWait(3541)).toBe("1 h");   // 59.02 min rounds up to 60
  });
  it("from 60 min on is hours + minutes", () => {
    expect(formatWait(3600)).toBe("1 h");
    expect(formatWait(3660)).toBe("1 h 1 min");
    expect(formatWait(86340)).toBe("23 h 59 min");
    expect(formatWait(86399)).toBe("24 h");
  });
  it("null for missing or non-positive", () => {
    for (const v of [null, undefined, 0, -5, "x", NaN]) expect(formatWait(v)).toBeNull();
  });
});

describe("formatCreatedAt", () => {
  it("formats a timestamp with date and time", () => {
    const out = formatCreatedAt("2026-11-12T14:05:00Z", "en-GB");
    expect(out).toMatch(/2026/);
    expect(out).toMatch(/\d{1,2}:\d{2}/);
  });
  it("empty for missing or unparseable", () => {
    expect(formatCreatedAt(null)).toBe("");
    expect(formatCreatedAt("not a date")).toBe("");
  });
});

describe("deadLinkRoute", () => {
  it("signed in -> profile (login would bounce to /game and lose the banner)", () => {
    expect(deadLinkRoute(true)).toBe("/game/profile");
  });
  it("signed out -> login with the expired banner", () => {
    expect(deadLinkRoute(false)).toBe("/login?link=expired");
  });
});
