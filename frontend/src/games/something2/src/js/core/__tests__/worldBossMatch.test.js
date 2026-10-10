import { describe, it, expect } from "vitest";
import { findWorldBossCreature } from "../worldBossMatch.js";

describe("findWorldBossCreature (SOMET-603)", () => {
  // Review Focus 2: a renamed row must still be found.
  it("matches by the server's bossCreatureId even when the name changed", () => {
    const all = [{ id: "x", name: "Old Name" }, { id: "wb_1", name: "zzRenamed", bossTier: "world" }];
    expect(findWorldBossCreature(all, { bossCreatureId: "wb_1", bossName: "Old Name" }).id).toBe("wb_1");
  });

  it("falls back to the one world-tier creature when the id is absent", () => {
    const all = [{ id: "a" }, { id: "b", bossTier: "world" }];
    expect(findWorldBossCreature(all, { bossName: "whatever" }).id).toBe("b");
  });

  it("never matches by name", () => {
    const all = [{ id: "a", name: "Ignis, the Magma Colossus", type: "Ignis, the Magma Colossus" }];
    expect(findWorldBossCreature(all, { bossName: "Ignis, the Magma Colossus" })).toBe(null);
  });

  it("a dungeon boss is not the world boss", () => {
    expect(findWorldBossCreature([{ id: "d", bossTier: "dungeon_end" }], {})).toBe(null);
  });
});
