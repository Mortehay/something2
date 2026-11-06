import { describe, it, expect } from "vitest";
import { worldBossHereOnly } from "../worldBossVisibility.js";

const active = { state: 'active', worldId: 'w-caldera', currentHp: 100, maxHp: 100 };

describe("worldBossHereOnly", () => {
  it("shows an active boss only in the world it is in", () => {
    expect(worldBossHereOnly(active, 'w-caldera')).toBe(active);
    expect(worldBossHereOnly(active, 'w-vale')).toBeNull();
  });
  it("compares ids as strings", () => {
    expect(worldBossHereOnly({ ...active, worldId: 7 }, '7')).not.toBeNull();
  });
  it("hides an active boss whose world is unknown, or when the player's world is", () => {
    expect(worldBossHereOnly({ ...active, worldId: null }, 'w-caldera')).toBeNull();
    expect(worldBossHereOnly(active, null)).toBeNull();
  });
  it("leaves the 'emerges in ...' warning visible everywhere, and passes null through", () => {
    const warn = { state: 'warning', worldId: 'w-caldera', timeToSpawnMs: 5000 };
    expect(worldBossHereOnly(warn, 'w-vale')).toBe(warn);
    expect(worldBossHereOnly(null, 'w-vale')).toBeNull();
  });
});
