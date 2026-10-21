import { describe, it, expect, vi } from "vitest";
import {
  boxDir, isBoxManifest, actionFrameKey, actionFrameCount, actionDurationMs, pickAction,
  frameKeyFor, actionTimings, rowFor, DEFAULT_FPS,
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
    expect(actionFrameKey(only, { dir: "n", action: "cast", startedAt: 0, now: 0 })).toBe("idle/n/0");
    // the idle fallback LOOPS (it is idle's own semantics), not clamps
    expect(actionFrameKey(only, { dir: "n", action: "damage", startedAt: 0, now: 500 })).toBe("idle/n/0");
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

// Old object-shaped view over the in-place pickAction.
function pick(state, now) {
  const rec = { ...state };
  const action = pickAction(rec, now);
  return { action, startedAt: rec.actionStartedAt };
}

describe("pickAction", () => {
  const base = { attackDurMs: 500, castDurMs: 750, phase: 37 };

  it("is idle when nothing happened, started at the entity's phase", () => {
    expect(pick({ ...base }, 1000)).toEqual({ action: "idle", startedAt: 37 });
  });

  it("is walk while moving, on the same stable phase", () => {
    expect(pick({ ...base, moving: true }, 1000)).toEqual({ action: "walk", startedAt: 37 });
    expect(pick({ ...base, movingUntil: 1100 }, 1000)).toEqual({ action: "walk", startedAt: 37 });
    expect(pick({ ...base, movingUntil: 1000 }, 1000).action).toBe("idle");
  });

  it("plays attack for one cycle from the event, then returns to walk/idle", () => {
    const s = { ...base, moving: true, attackAt: 1000 };
    expect(pick(s, 1000)).toEqual({ action: "attack", startedAt: 1000 });
    expect(pick(s, 1499)).toEqual({ action: "attack", startedAt: 1000 });
    expect(pick(s, 1500).action).toBe("walk");
  });

  it("plays cast for its own duration", () => {
    const s = { ...base, castAt: 1000 };
    expect(pick(s, 1749)).toEqual({ action: "cast", startedAt: 1000 });
    expect(pick(s, 1750).action).toBe("idle");
  });

  it("does not play an action the sheet lacks (duration 0)", () => {
    expect(pick({ ...base, castDurMs: 0, castAt: 1000 }, 1000).action).toBe("idle");
  });

  it("damage wins over attack, cast and walk for 300 ms", () => {
    const s = { ...base, moving: true, attackAt: 1000, castAt: 1000, hitAt: 1050 };
    expect(pick(s, 1100)).toEqual({ action: "damage", startedAt: 1050 });
    expect(pick(s, 1349)).toEqual({ action: "damage", startedAt: 1050 });
    // after the flinch, the still-running attack/cast resumes on ITS clock
    expect(pick(s, 1350).action).toBe("cast");
    expect(pick(s, 1350).startedAt).toBe(1000);
  });

  it("honours a caller damage window (0 = the sheet has no damage rows)", () => {
    expect(pick({ ...base, hitAt: 1000, damageMs: 0 }, 1000).action).toBe("idle");
  });

  it("the more recent of attack and cast wins when both are running", () => {
    expect(pick({ ...base, attackAt: 1000, castAt: 1100 }, 1200)).toEqual({ action: "cast", startedAt: 1100 });
    expect(pick({ ...base, attackAt: 1100, castAt: 1000 }, 1200)).toEqual({ action: "attack", startedAt: 1100 });
  });

  it("treats missing timestamps as never", () => {
    expect(pick({}, 0)).toEqual({ action: "idle", startedAt: 0 });
  });
});

describe("actionTimings (per-manifest cache)", () => {
  it("returns the same object each call, with attack/cast/damage values", () => {
    const m = sheet(["idle", "attack", "damage"], ["s"], 6);
    const t = actionTimings(m);
    expect(t).toBe(actionTimings(m));
    expect(t.attackDurMs).toBe(750);
    expect(t.castDurMs).toBe(0);
    expect(t.damageMs).toBe(300);
    expect(actionTimings(sheet(["idle"], ["s"])).damageMs).toBe(0);
  });

  it("computes once per manifest: repeat calls do not re-walk the rows", () => {
    const m = sheet(["idle", "attack"], ["s"], 6);
    actionTimings(m);
    const spy = vi.spyOn(Map.prototype, "values");
    for (let i = 0; i < 50; i += 1) actionTimings(m);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("pickAction on an existing record", () => {
  it("writes action/actionStartedAt into the record and returns the action string", () => {
    const rec = { attackAt: 1000, attackDurMs: 500, phase: 3 };
    const r1 = pickAction(rec, 1100);
    expect(r1).toBe("attack");
    expect(rec.action).toBe("attack");
    expect(rec.actionStartedAt).toBe(1000);
    expect(pickAction(rec, 2000)).toBe("idle");
    expect(rec.actionStartedAt).toBe(3);
  });
});

describe("frameKeyFor", () => {
  it("matches actionFrameKey for the same inputs", () => {
    const m = sheet(["idle", "walk", "attack"], ALL, 4);
    for (const action of ["idle", "walk", "attack", "cast"]) {
      expect(frameKeyFor(m, "e", action, 100, 460, DEFAULT_FPS))
        .toBe(actionFrameKey(m, { dir: "e", action, startedAt: 100, now: 460 }));
    }
    expect(frameKeyFor(null, "e", "idle", 0, 0, DEFAULT_FPS)).toBe(null);
  });
});

// SOMET-659: the box's western rows are broken, so a western screen direction
// is drawn as the eastern row mirrored horizontally.
describe("rowFor (western rows are mirrored eastern rows)", () => {
  const full = sheet(["idle", "attack"], ALL, 2);
  const out = { flipX: null };
  const row = (m, dir, action = "idle") => [rowFor(m, action, dir, out), out.flipX];

  it("draws w / nw / sw as e / ne / se flipped", () => {
    expect(row(full, "w")).toEqual(["e", true]);
    expect(row(full, "nw")).toEqual(["ne", true]);
    expect(row(full, "sw")).toEqual(["se", true]);
  });

  it("leaves the other directions alone, unflipped", () => {
    for (const d of ["s", "se", "e", "ne", "n"]) expect(row(full, d)).toEqual([d, false]);
  });

  it("uses the western row unflipped when the eastern counterpart is missing", () => {
    const west = sheet(["idle"], ["s", "n", "w", "nw", "sw"], 2);
    expect(row(west, "w")).toEqual(["w", false]);
    expect(row(west, "nw")).toEqual(["nw", false]);
    expect(row(west, "sw")).toEqual(["sw", false]);
  });

  it("falls back to the nearest direction, unflipped, when both are missing", () => {
    const only = sheet(["idle"], ["s", "n"], 2);
    expect(row(only, "w")).toEqual(["s", false]);
    expect(row(only, "nw")).toEqual(["n", false]);
    expect(row(only, "sw")).toEqual(["s", false]);
  });

  it("a nearest-direction fallback never lands on a broken western row while its eastern twin exists", () => {
    // n missing; the nearest search ties nw/ne and would pick nw (unflipped) first.
    const gap = sheet(["idle"], ["s", "se", "e", "ne", "nw", "w", "sw"], 2);
    expect(row(gap, "n")).toEqual(["ne", true]);
    // s missing: the tie between se and sw goes to se first, an eastern row, so no flip.
    const gapS = sheet(["idle"], ["se", "e", "ne", "n", "nw", "w", "sw"], 2);
    expect(row(gapS, "s")).toEqual(["se", false]);
    // w has neither its own row nor e; the nearest is nw, whose twin ne exists -> ne mirrored.
    const gapW = sheet(["idle"], ["s", "ne", "n", "nw"], 2);
    expect(row(gapW, "w")).toEqual(["ne", true]);
  });

  it("returns null for a missing action or a non-box manifest", () => {
    expect(row(full, "w", "cast")).toEqual([null, false]);
    expect(row({ frames: {} }, "w")).toEqual([null, false]);
  });

  it("frameKeyFor / actionFrameKey draw the mirrored key and report the flip", () => {
    const rec = { flipX: false };
    expect(frameKeyFor(full, "w", "attack", 0, 125, DEFAULT_FPS, rec)).toBe("attack/e/1");
    expect(rec.flipX).toBe(true);
    expect(frameKeyFor(full, "e", "attack", 0, 125, DEFAULT_FPS, rec)).toBe("attack/e/1");
    expect(rec.flipX).toBe(false);
    // the idle fallback mirrors too
    expect(frameKeyFor(full, "sw", "walk", 0, 0, DEFAULT_FPS, rec)).toBe("idle/se/0");
    expect(rec.flipX).toBe(true);
    // no key -> no flip
    expect(frameKeyFor(sheet(["walk"], ["s"]), "w", "attack", 0, 0, DEFAULT_FPS, rec)).toBe(null);
    expect(rec.flipX).toBe(false);
    const o = { flipX: false };
    expect(actionFrameKey(full, { dir: "nw", action: "idle", startedAt: 0, now: 0, out: o })).toBe("idle/ne/0");
    expect(o.flipX).toBe(true);
    // without a record it still returns the mirrored key
    expect(frameKeyFor(full, "w", "idle", 0, 0, DEFAULT_FPS)).toBe("idle/e/0");
  });
});
