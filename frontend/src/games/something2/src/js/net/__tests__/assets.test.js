import { describe, it, expect } from "vitest";
import { assetUrl } from "../assets.js";

const API = "http://api.test";
const KEY = "sprites/objects/Wolf/static.png";

describe("assetUrl", () => {
  it("routes through the backend proxy rather than MinIO", () => {
    expect(assetUrl(API, KEY)).toBe(`${API}/api/assets/${KEY}`);
  });

  // The regression this exists for, observed in the browser: after approving a
  // regenerated Wolf, the URL the game loads returned the OLD 128x160 image
  // from cache while a cache-busted URL returned the new 102x150 one, so the
  // creature kept rendering with its old baked-in background.
  it("produces a different URL once the row has been updated", () => {
    const before = assetUrl(API, KEY, "2026-07-24T07:00:00.000Z");
    const after = assetUrl(API, KEY, "2026-07-24T07:56:33.714Z");
    expect(before).not.toBe(after);
    expect(after).toContain("?v=");
  });

  it("escapes a version containing URL-significant characters", () => {
    expect(assetUrl(API, KEY, "a b&c")).toBe(`${API}/api/assets/${KEY}?v=a%20b%26c`);
  });

  it("leaves the URL bare when there is no version to key on", () => {
    expect(assetUrl(API, KEY, null)).toBe(`${API}/api/assets/${KEY}`);
    expect(assetUrl(API, KEY, undefined)).toBe(`${API}/api/assets/${KEY}`);
  });

  it("is null for a missing key", () => {
    expect(assetUrl(API, null, "v1")).toBeNull();
    expect(assetUrl(API, "", "v1")).toBeNull();
  });
});
