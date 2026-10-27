import { describe, it, expect } from "vitest";
import { showWorldBossTestPanel } from "../worldBossPanelGate";

describe("showWorldBossTestPanel", () => {
  it("hides the panel from a non-admin who is playing", () => {
    expect(showWorldBossTestPanel({ isPlaying: true, isAdmin: false })).toBe(false);
    expect(showWorldBossTestPanel({ isPlaying: true, isAdmin: undefined })).toBe(false);
  });
  it("shows it to an admin who is playing", () => {
    expect(showWorldBossTestPanel({ isPlaying: true, isAdmin: true })).toBe(true);
  });
  it("hides it when not playing, admin or not", () => {
    expect(showWorldBossTestPanel({ isPlaying: false, isAdmin: true })).toBe(false);
  });
});
