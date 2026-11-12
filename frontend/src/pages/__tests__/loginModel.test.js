import { describe, it, expect } from "vitest";
import { loginBannerFor, registerPrefill, errorText } from "../loginModel.js";

const qs = (s) => new URLSearchParams(s);

describe("loginBannerFor", () => {
  it("maps verified=1", () => {
    expect(loginBannerFor(qs("verified=1"))).toEqual({
      kind: "ok",
      text: "Your email is verified — you can sign in",
    });
  });
  it("maps reset=1", () => {
    expect(loginBannerFor(qs("reset=1"))).toEqual({
      kind: "ok",
      text: "Password changed — sign in with the new one",
    });
  });
  it("maps link=expired as an error", () => {
    expect(loginBannerFor(qs("link=expired"))).toEqual({
      kind: "error",
      text: "This link was already used or has expired — request a new one",
    });
  });
  it("returns null for nothing or unknown values", () => {
    expect(loginBannerFor(qs(""))).toBeNull();
    expect(loginBannerFor(qs("verified=0&link=other"))).toBeNull();
    expect(loginBannerFor(null)).toBeNull();
  });
});

describe("registerPrefill", () => {
  it("reads register, invite and email", () => {
    expect(registerPrefill(qs("register=1&invite=ABCD-EFGH-JKMN&email=a%40b.co"))).toEqual({
      register: true,
      invite: "ABCD-EFGH-JKMN",
      email: "a@b.co",
    });
  });
  it("defaults when absent", () => {
    expect(registerPrefill(qs(""))).toEqual({ register: false, invite: "", email: "" });
    expect(registerPrefill(null)).toEqual({ register: false, invite: "", email: "" });
  });
  it("invite alone does not imply register", () => {
    expect(registerPrefill(qs("invite=X")).register).toBe(false);
  });
});

describe("errorText", () => {
  const codes = [
    "email_not_verified", "email_taken", "email_locked", "resend_cooldown",
    "link_expired", "email_failed", "no_link_origin", "invalid_email",
    "not_pending", "too_many_requests", "unauthorized", "misconfigured",
    "invalid credentials", "username is taken", "an invite code is required",
    "registration is closed", "invalid or already-used invite code",
    "username and password are required", "password is required",
  ];
  const fallback = errorText("zzz_unknown");
  it("has a distinct specific message for every known code", () => {
    const seen = new Set();
    for (const c of codes) {
      const text = errorText(c);
      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(5);
      expect(text).not.toBe(fallback);
      seen.add(text);
    }
    expect(seen.size).toBe(codes.length);
  });
  it("falls back for unknown or missing codes", () => {
    expect(fallback).toBe("Something went wrong — please try again");
    expect(errorText(undefined)).toBe(fallback);
  });
  it("mentions the wait for resend_cooldown when given seconds", () => {
    expect(errorText("resend_cooldown", 42)).toContain("42");
  });
});
