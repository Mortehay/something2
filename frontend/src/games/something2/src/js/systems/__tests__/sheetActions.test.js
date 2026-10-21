import { describe, it, expect } from "vitest";
import {
  boxDir, isBoxManifest, actionFrameKey, actionFrameCount, actionDurationMs, pickAction,
} from "../sheetActions.js";

// A box sheet.json: `actions` x `dirs`, `n` frames each, rects from the grid.
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

const ALL = ["s", "se", "e", "ne", "n", "nw", "w", "sw"];

describe("boxDir", () => {
  // Facings are WORLD directions; box sheet rows are SCREEN (camera) directions,
  // "s" = facing the viewer. worldToScreen (core/iso.js) turns world SE (+x,+y)
  // into straight down and world NW into straight up, i.e. a 45-degree turn.
  const WORLD = ["E", "SE", "S", "SW", "W", "NW", "N", "NE"];
  const SCREEN = ["se", "s", "sw", "w", "nw", "n", "ne", "e"];
  it("maps the creature's upper-case world facing to the on-screen sheet direction", () => {
    expect(WORLD.map(boxDir)).toEqual(SCREEN);
  });
  it("maps the player's lower-case world facing the same way", () => {
    expect(WORLD.map((d) => boxDir(d.toLowerCase()))).toEqual(SCREEN);
  });
  it("walking up the screen (W key: world nw) shows the back row, down the screen (world se) the front", () => {
    expect(boxDir("nw")).toBe("n");
    expect(boxDir("se")).toBe("s");
  });
  it("defaults anything unknown to s", () => {
    for (const f of [undefined, null, "", "x", "south", 3, {}]) expect(boxDir(f)).toBe("s");
  });
});

describe("isBoxManifest", () => {
  it("is true only for a manifest with a non-empty rows array", () => {
    expect(isBoxManifest(sheet(["idle"], ["s"]))).toBe(true);
    expect(isBoxManifest({ frames: { "S/0": [0, 0, 1, 1] } })).toBe(false);
    expect(isBoxManifest({ rows: [], frames: {} })).toBe(false);
    expect(isBoxManifest({ rows: "x" })).toBe(false);
    expect(isBoxManifest(null)).toBe(false);
    expect(isBoxManifest(undefined)).toBe(false);
  });
});

describe("actionFrameCount / actionDurationMs", () => {
  const m = sheet(["idle", "attack"], ["s", "e"], 6);
  it("reads the row's frame count", () => {
    expect(actionFrameCount(m, "attack")).toBe(6);
    expect(actionFrameCount(m, "cast")).toBe(0);
    expect(actionFrameCount(null, "idle")).toBe(0);
  });
  it("is one cycle of the action at fps", () => {
    expect(actionDurationMs(m, "attack", 8)).toBe(750);
    expect(actionDurationMs(m, "attack", 6)).toBe(1000);
    expect(actionDurationMs(m, "cast", 8)).toBe(0);
  });
});

describe("actionFrameKey", () => {
  const m = sheet(["idle", "walk", "attack", "cast", "damage"], ALL, 4);
  const at = (action, startedAt, now, extra = {}) =>
    actionFrameKey(m, { dir: "e", action, startedAt, now, ...extra });

  it("formats keys as <action>/<dir>/<i>", () => {
    expect(at("idle", 0, 0)).toBe("idle/e/0");
  });

  it("loops idle and walk at 8 fps by default", () => {
    // 125 ms per frame at 8 fps
    expect(at("walk", 0, 124)).toBe("walk/e/0");
    expect(at("walk", 0, 125)).toBe("walk/e/1");
    expect(at("walk", 0, 375)).toBe("walk/e/3");
    expect(at("walk", 0, 500)).toBe("walk/e/0");
    expect(at("idle", 1000, 1000 + 625)).toBe("idle/e/1");
  });

  it("wraps a loop correctly when now is before the phase start", () => {
    // -125 ms -> frame -1 -> wraps to the last frame, never "idle/e/-1"
    expect(at("idle", 500, 375)).toBe("idle/e/3");
  });

  it("clamps one-shots to their last frame", () => {
    for (const a of ["attack", "cast", "damage"]) {
      expect(at(a, 100, 100)).toBe(`${a}/e/0`);
      expect(at(a, 100, 100 + 250)).toBe(`${a}/e/2`);
      expect(at(a, 100, 100 + 375)).toBe(`${a}/e/3`);
      expect(at(a, 100, 100 + 10000)).toBe(`${a}/e/3`);
      expect(at(a, 100, 50)).toBe(`${a}/e/0`);
    }
  });

  it("treats use as a one-shot too", () => {
    const u = sheet(["idle", "use"], ["s"], 3);
    expect(actionFrameKey(u, { dir: "s", action: "use", startedAt: 0, now: 99999 })).toBe("use/s/2");
  });

  it("honours an explicit fps and loop flag", () => {
    expect(at("attack", 0, 250, { fps: 4 })).toBe("attack/e/1");
    expect(at("attack", 0, 500 * 4 + 1, { loop: true, fps: 4 })).toBe("attack/e/0");
    expect(at("walk", 0, 99999, { loop: false })).toBe("walk/e/3");
  });

  it("falls back to the same action at the nearest direction", () => {
    const only = sheet(["idle", "attack"], ["s", "n"], 2);
    // ne is 1 step from n, 3 from s
    expect(actionFrameKey(only, { dir: "ne", action: "attack", startedAt: 0, now: 0 })).toBe("attack/n/0");
    // se is 1 step from s
    expect(actionFrameKey(only, { dir: "se", action: "attack", startedAt: 0, now: 0 })).toBe("attack/s/0");
    // w is 2 steps from both s (via sw) and n (via nw): the tie goes to the
    // next direction in s,se,e,ne,n,nw,w,sw order (w -> sw -> s)
    expect(actionFrameKey(only, { dir: "w", action: "attack", startedAt: 0, now: 0 })).toBe("attack/s/0");
    // e is 2 steps from both too; e -> ne -> n
    expect(actionFrameKey(only, { dir: "e", action: "attack", startedAt: 0, now: 0 })).toBe("attack/n/0");
  });

  it("measures direction distance around the circle (sw is next to s)", () => {
    const only = sheet(["idle"], ["sw", "ne"], 1);
    expect(actionFrameKey(only, { dir: "s", action: "idle", startedAt: 0, now: 0 })).toBe("idle/sw/0");
    expect(actionFrameKey(only, { dir: "n", action: "idle", startedAt: 0, now: 0 })).toBe("idle/ne/0");
  });

  it("falls back to idle at the same direction when the action is absent", () => {
    const only = sheet(["idle"], ALL, 4);
    expect(actionFrameKey(only, { dir: "w", action: "cast", startedAt: 0, now: 0 })).toBe("idle/w/0");
    // the idle fallback LOOPS (it is idle's own semantics), not clamps
    expect(actionFrameKey(only, { dir: "w", action: "damage", startedAt: 0, now: 500 })).toBe("idle/w/0");
  });

  it("falls back to idle at the nearest direction", () => {
    const only = sheet(["idle"], ["n"], 4);
    expect(actionFrameKey(only, { dir: "nw", action: "walk", startedAt: 0, now: 0 })).toBe("idle/n/0");
  });

  it("returns null when neither the action nor idle exists", () => {
    const only = sheet(["walk"], ["s"], 4);
    expect(actionFrameKey(only, { dir: "s", action: "attack", startedAt: 0, now: 0 })).toBe(null);
    expect(actionFrameKey({ frames: { "S/0": [0, 0, 1, 1] } }, { dir: "s", action: "idle", startedAt: 0, now: 0 })).toBe(null);
    expect(actionFrameKey(null, { dir: "s", action: "idle", startedAt: 0, now: 0 })).toBe(null);
  });

  it("never yields a non-finite index for junk times", () => {
    expect(at("walk", NaN, 100)).toBe("walk/e/0");
    expect(at("attack", 0, Infinity)).toBe("attack/e/0");
  });
});

describe("pickAction", () => {
  const base = { attackDurMs: 500, castDurMs: 750, phase: 37 };

  it("is idle when nothing happened, started at the entity's phase", () => {
    expect(pickAction({ ...base }, 1000)).toEqual({ action: "idle", startedAt: 37 });
  });

  it("is walk while moving, on the same stable phase", () => {
    expect(pickAction({ ...base, moving: true }, 1000)).toEqual({ action: "walk", startedAt: 37 });
    expect(pickAction({ ...base, movingUntil: 1100 }, 1000)).toEqual({ action: "walk", startedAt: 37 });
    expect(pickAction({ ...base, movingUntil: 1000 }, 1000).action).toBe("idle");
  });

  it("plays attack for one cycle from the event, then returns to walk/idle", () => {
    const s = { ...base, moving: true, attackAt: 1000 };
    expect(pickAction(s, 1000)).toEqual({ action: "attack", startedAt: 1000 });
    expect(pickAction(s, 1499)).toEqual({ action: "attack", startedAt: 1000 });
    expect(pickAction(s, 1500).action).toBe("walk");
  });

  it("plays cast for its own duration", () => {
    const s = { ...base, castAt: 1000 };
    expect(pickAction(s, 1749)).toEqual({ action: "cast", startedAt: 1000 });
    expect(pickAction(s, 1750).action).toBe("idle");
  });

  it("does not play an action the sheet lacks (duration 0)", () => {
    expect(pickAction({ ...base, castDurMs: 0, castAt: 1000 }, 1000).action).toBe("idle");
  });

  it("damage wins over attack, cast and walk for 300 ms", () => {
    const s = { ...base, moving: true, attackAt: 1000, castAt: 1000, hitAt: 1050 };
    expect(pickAction(s, 1100)).toEqual({ action: "damage", startedAt: 1050 });
    expect(pickAction(s, 1349)).toEqual({ action: "damage", startedAt: 1050 });
    // after the flinch, the still-running attack/cast resumes on ITS clock
    expect(pickAction(s, 1350).action).toBe("cast");
    expect(pickAction(s, 1350).startedAt).toBe(1000);
  });

  it("honours a caller damage window (0 = the sheet has no damage rows)", () => {
    expect(pickAction({ ...base, hitAt: 1000, damageMs: 0 }, 1000).action).toBe("idle");
  });

  it("the more recent of attack and cast wins when both are running", () => {
    expect(pickAction({ ...base, attackAt: 1000, castAt: 1100 }, 1200)).toEqual({ action: "cast", startedAt: 1100 });
    expect(pickAction({ ...base, attackAt: 1100, castAt: 1000 }, 1200)).toEqual({ action: "attack", startedAt: 1100 });
  });

  it("treats missing timestamps as never", () => {
    expect(pickAction({}, 0)).toEqual({ action: "idle", startedAt: 0 });
  });
});
