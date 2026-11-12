import { describe, it, expect } from "vitest";
import { maskEmail, emailSectionState, inviteStatus, canCreateInvite } from "../profileModel.js";
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
    expect(errorText("invite_limit", 3600)).toBe("You've used all your invite codes — the next one frees up in 60 min");
    expect(errorText("invite_limit", 90)).toBe("You've used all your invite codes — the next one frees up in 2 min");
  });
});
