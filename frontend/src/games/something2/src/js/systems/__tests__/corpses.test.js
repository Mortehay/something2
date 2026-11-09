import { describe, it, expect } from "vitest";
import {
  CorpseStore, corpseAt, makeCorpse, hasDeathRow,
  HOLD_MS, FADE_MS, MAX_CORPSES, DEATH_MATCH_MS, DEATH_MATCH_PX,
} from "../corpses.js";
import { DEATH_FRAME_MS, rowFor, boxDir } from "../sheetActions.js";

const ALL = ["s", "se", "e", "ne", "n", "nw", "w", "sw"];

function sheet(actions, dirs, n = 4) {
  const rows = [];
  const frames = {};
  let row = 0;
  for (const action of actions) {
    for (const direction of dirs) {
      rows.push({ row, action, direction, frames: n });
      for (let i = 0; i < n; i += 1) frames[`${action}/${direction}/${i}`] = [i * 10, row * 10, 10, 10];
      row += 1;
    }
  }
  return { version: 1, cell: [10, 10], actions, frames_per_action: n, rows, frames };
}

const WITH_DEATH = sheet(["idle", "walk", "death"], ALL);
const NO_DEATH = sheet(["idle", "walk"], ALL);

function creature(over = {}, manifest = WITH_DEATH) {
  return {
    id: 7, type: "Wolf", x: 100, y: 200, tx: 100, ty: 200, width: 48, height: 48,
    facing: "S", sprite: manifest ? { atlas_key: "wolf", manifest } : null, ...over,
  };
}
// The authority's death sfx: the creature's CENTRE, rounded (sfxEvents.creatureDeath).
const deathOf = (c, over = {}) => ({ e: "death", c: c.type, x: Math.round(c.x + 24), y: Math.round(c.y + 24), ...over });

describe("corpse timeline", () => {
  const c = makeCorpse(creature(), 1000);
  it("starts on frame 0 at full alpha", () => {
    expect(corpseAt(c, 1000)).toEqual({ frame: 0, alpha: 1 });
  });
  it("steps one frame per DEATH_FRAME_MS and lands on the last frame after the row", () => {
    expect(corpseAt(c, 1000 + DEATH_FRAME_MS).frame).toBe(1);
    expect(corpseAt(c, 1000 + 3 * DEATH_FRAME_MS).frame).toBe(3);
    expect(corpseAt(c, 1000 + 4 * DEATH_FRAME_MS)).toEqual({ frame: 3, alpha: 1 });
  });
  it("holds the last frame at full alpha until HOLD_MS after the row", () => {
    const end = 1000 + 4 * DEATH_FRAME_MS;
    expect(corpseAt(c, end + HOLD_MS - 1)).toEqual({ frame: 3, alpha: 1 });
  });
  it("fades out over FADE_MS, on the last frame", () => {
    const fade = 1000 + 4 * DEATH_FRAME_MS + HOLD_MS;
    const a1 = corpseAt(c, fade + FADE_MS * 0.25);
    const a2 = corpseAt(c, fade + FADE_MS * 0.75);
    expect(a1.frame).toBe(3);
    expect(a1.alpha).toBeLessThan(1);
    expect(a2.alpha).toBeLessThan(a1.alpha);
    expect(a2.alpha).toBeGreaterThan(0);
  });
  it("is gone after the fade", () => {
    expect(corpseAt(c, 1000 + 4 * DEATH_FRAME_MS + HOLD_MS + FADE_MS)).toBe(null);
  });
  it("takes its frame count from the row (6 frames)", () => {
    const six = makeCorpse(creature({}, sheet(["idle", "death"], ALL, 6)), 0);
    expect(six.frames).toBe(6);
    expect(corpseAt(six, 5 * DEATH_FRAME_MS).frame).toBe(5);
    expect(corpseAt(six, 6 * DEATH_FRAME_MS + HOLD_MS - 1)).toEqual({ frame: 5, alpha: 1 });
  });
});

describe("makeCorpse", () => {
  it("needs a death row: none without one, or without a sheet", () => {
    expect(hasDeathRow(WITH_DEATH)).toBe(true);
    expect(hasDeathRow(NO_DEATH)).toBe(false);
    expect(makeCorpse(creature({}, NO_DEATH), 0)).toBe(null);
    expect(makeCorpse(creature({}, null), 0)).toBe(null);
    expect(makeCorpse(creature({ sprite: { atlas_key: "x" } }), 0)).toBe(null);
  });
  it("a west facing flips exactly as a living creature facing west would", () => {
    for (const facing of ["W", "NW", "SW", "N", "E"]) {
      const c = makeCorpse(creature({ facing }), 0);
      const out = {};
      const row = rowFor(WITH_DEATH, "walk", boxDir(facing), out);
      expect(c.dir).toBe(row);
      expect(c.flipX).toBe(out.flipX);
    }
    // World W is screen nw: drawn as the ne row, mirrored.
    const w = makeCorpse(creature({ facing: "W" }), 0);
    expect(w.flipX).toBe(true);
    expect(w.dir).toBe("ne");
  });
  it("keeps where it fell and what it looked like, not the live object", () => {
    const live = creature({ x: 130.5, y: 210.25 });
    const c = makeCorpse(live, 0);
    live.x = 999;
    expect(c.x).toBe(130.5);
    expect(c.y).toBe(210.25);
    expect(c.sprite).toBe(live.sprite);
  });
});

describe("CorpseStore: a death sfx + the creature leaving the snapshot", () => {
  it("a creature removed after its death sfx becomes a corpse", () => {
    const s = new CorpseStore();
    const c = creature();
    s.noteDeaths([{ e: "hurt", c: "Wolf", x: 0, y: 0 }, deathOf(c)], 1000);
    expect(s.onRemoved(c, 1100)).not.toBe(null);
    expect(s.live(1100).map((k) => k.id)).toEqual([7]);
    expect(s.live(1100)[0].startedAt).toBe(1100);
  });
  it("a creature that only left the neighbourhood (no death sfx) just vanishes", () => {
    const s = new CorpseStore();
    expect(s.onRemoved(creature(), 1000)).toBe(null);
    expect(s.live(1000)).toEqual([]);
  });
  it("no death row: no corpse, even with the death sfx", () => {
    const s = new CorpseStore();
    const c = creature({}, NO_DEATH);
    s.noteDeaths([deathOf(c)], 1000);
    expect(s.onRemoved(c, 1000)).toBe(null);
    expect(s.live(1000)).toEqual([]);
  });
  it("matches on type and position: another type or a far death does not count", () => {
    const s = new CorpseStore();
    const c = creature();
    s.noteDeaths([deathOf(c, { c: "Bear" }), deathOf(c, { x: c.x + 24 + DEATH_MATCH_PX + 1 })], 1000);
    expect(s.onRemoved(c, 1000)).toBe(null);
  });
  it("matches against the snapshot target too (the server's position at death)", () => {
    const s = new CorpseStore();
    const c = creature({ x: 0, y: 0, tx: 300, ty: 300 });
    s.noteDeaths([{ e: "death", c: "Wolf", x: 324, y: 324 }], 1000);
    expect(s.onRemoved(c, 1000)).not.toBe(null);
  });
  it("a death sfx is used once, and expires after DEATH_MATCH_MS", () => {
    const s = new CorpseStore();
    const a = creature({ id: 1 });
    const b = creature({ id: 2 });
    s.noteDeaths([deathOf(a)], 1000);
    expect(s.onRemoved(a, 1000)).not.toBe(null);
    expect(s.onRemoved(b, 1000)).toBe(null);
    s.noteDeaths([deathOf(b)], 2000);
    expect(s.onRemoved(b, 2000 + DEATH_MATCH_MS + 1)).toBe(null);
  });
  it("the same id reappearing drops its corpse at once", () => {
    const s = new CorpseStore();
    const c = creature();
    s.noteDeaths([deathOf(c)], 1000);
    s.onRemoved(c, 1000);
    s.dropId(7);
    expect(s.live(1001)).toEqual([]);
  });
  it("a corpse past its fade is dropped by live()", () => {
    const s = new CorpseStore();
    const c = creature();
    s.noteDeaths([deathOf(c)], 0);
    s.onRemoved(c, 0);
    expect(s.live(4 * DEATH_FRAME_MS + HOLD_MS + FADE_MS)).toEqual([]);
    expect(s.size).toBe(0);
  });
  it(`caps at MAX_CORPSES (${MAX_CORPSES}): one more evicts the oldest`, () => {
    const s = new CorpseStore();
    for (let i = 1; i <= MAX_CORPSES + 1; i += 1) {
      const c = creature({ id: i });
      s.noteDeaths([deathOf(c)], i);
      expect(s.onRemoved(c, i)).not.toBe(null);
    }
    const ids = s.live(MAX_CORPSES + 1).map((k) => k.id);
    expect(ids.length).toBe(MAX_CORPSES);
    expect(ids).not.toContain(1);
    expect(ids).toContain(2);
    expect(ids).toContain(MAX_CORPSES + 1);
  });
  it("bounds the pending death list too (a mass kill nobody draws)", () => {
    const s = new CorpseStore();
    const many = Array.from({ length: 1000 }, (_, i) => ({ e: "death", c: "Wolf", x: i * 1000, y: 0 }));
    s.noteDeaths(many, 0);
    expect(s.pendingDeaths).toBeLessThanOrEqual(MAX_CORPSES);
  });
  it("ignores junk input", () => {
    const s = new CorpseStore();
    expect(() => s.noteDeaths(null, 0)).not.toThrow();
    expect(() => s.noteDeaths([null, { e: "death" }, { e: "death", c: "Wolf", x: NaN, y: 0 }], 0)).not.toThrow();
    expect(s.onRemoved(null, 0)).toBe(null);
    s.clear();
    expect(s.size).toBe(0);
  });
});
