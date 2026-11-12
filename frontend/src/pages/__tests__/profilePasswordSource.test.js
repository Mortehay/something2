import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("password change keeps the session (source gate)", () => {
  const profile = read("../Profile.jsx");
  const ctx = read("../../context/AuthContext.jsx");
  it("Profile swaps the token with replaceToken, never signIn", () => {
    expect(profile).toContain("replaceToken");
    expect(profile).not.toMatch(/\bsignIn\b/);
  });
  it("replaceToken does not clear the account, probe or cache", () => {
    const m = ctx.match(/const replaceToken = useCallback\(([\s\S]*?)\n {2}\}, \[\]\);/);
    expect(m).not.toBeNull();
    expect(m[1]).not.toMatch(/setAccount|setProbe|queryClient/);
    expect(m[1]).toMatch(/storeToken/);
  });
});
