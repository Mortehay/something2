import { describe, it, expect } from "vitest";
import { worldBossHereOnly, worldBossCountdown, worldBossArenaHere, worldBossForMinimap } from "../worldBossVisibility.js";

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

describe("worldBossCountdown", () => {
  it("counts the warning down from when the status arrived, never below zero", () => {
    const s = { state: 'warning', timeToSpawnMs: 10000, _at: 1000 };
    expect(worldBossCountdown(s, 4000).timeToSpawnMs).toBe(7000);
    expect(worldBossCountdown(s, 99000).timeToSpawnMs).toBe(0);
  });
  it("leaves every other state, and a status with no arrival stamp, alone", () => {
    const a = { state: 'active', timeToSpawnMs: 5 };
    expect(worldBossCountdown(a, 9)).toBe(a);
    const w = { state: 'warning', timeToSpawnMs: 5000 };
    expect(worldBossCountdown(w, 9)).toBe(w);
    expect(worldBossCountdown(null, 9)).toBeNull();
  });
});

describe("worldBossArenaHere", () => {
  const act = { state: 'active', worldId: 'w1', arena: { x: 100, y: 200, r: 450, name: 'A' } };
  it("returns the arena only for an active boss in this world", () => {
    expect(worldBossArenaHere(act, 'w1')).toEqual(act.arena);
    expect(worldBossArenaHere(act, 'w2')).toBeNull();
    expect(worldBossArenaHere({ ...act, state: 'warning' }, 'w1')).toBeNull();
    expect(worldBossArenaHere({ ...act, arena: null }, 'w1')).toBeNull();
  });
});

describe("worldBossForMinimap", () => {
  const act = { state: 'active', worldId: 'w1', arena: { x: 100, y: 200, r: 450 } };
  const find = (list) => list.find((c) => c.bossTier === 'world') || null;
  it("puts the marker on the live boss, else on the arena", () => {
    const live = [{ bossTier: 'world', x: 40, y: 60, width: 20, height: 20 }];
    expect(worldBossForMinimap(act, 'w1', live, find)).toMatchObject({ x: 50, y: 70 });
    expect(worldBossForMinimap(act, 'w1', [], find)).toMatchObject({ x: 100, y: 200 });
  });
  it("shows nothing in another world, and passes a warning through untouched", () => {
    expect(worldBossForMinimap(act, 'w2', [], find)).toBeNull();
    const warn = { state: 'warning', worldId: 'w1' };
    expect(worldBossForMinimap(warn, 'w2', [], find)).toBe(warn);
  });
});
