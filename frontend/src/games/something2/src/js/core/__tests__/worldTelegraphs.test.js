import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { telegraphsFromFrame } from "../worldTelegraphs.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const telegraph = (over = {}) => ({
  creatureId: "c:1", skill: "Ground Slam", x: 100, y: 200, radius: 80, ms: 300, telegraphMs: 500, ...over,
});

describe("telegraphsFromFrame", () => {
  it("carries the resolved geometry through to the renderer", () => {
    const [t] = telegraphsFromFrame({ telegraphs: [telegraph()] });
    expect(t).toEqual({
      creatureId: "c:1", skill: "Ground Slam", v: null, x: 100, y: 200, radius: 80, ms: 300, telegraphMs: 500,
    });
  });

  // SOMET-610 (S7): the vfx binding's resolved name, server-resolved same
  // as every other effect name (the client holds no creature_skills
  // catalog to look a raw binding up in).
  it("carries the resolved vfx name through; a non-string is dropped to null", () => {
    expect(telegraphsFromFrame({ telegraphs: [telegraph({ v: "fireball_blast" })] })[0].v).toBe("fireball_blast");
    expect(telegraphsFromFrame({ telegraphs: [telegraph({ v: 123 })] })[0].v).toBe(null);
    expect(telegraphsFromFrame({ telegraphs: [telegraph({ v: undefined })] })[0].v).toBe(null);
  });

  // The server OMITS the key entirely when nothing is telegraphing, which is
  // the overwhelmingly common case. That must be an empty list, not a crash.
  it("collapses an absent or malformed frame to empty", () => {
    for (const msg of [{}, { telegraphs: null }, { telegraphs: "no" }, undefined, null]) {
      expect(telegraphsFromFrame(msg)).toEqual([]);
    }
  });

  // Canvas 2D SILENTLY DROPS a path with non-finite coordinates -- no error,
  // nothing drawn (SOMET-488's own lesson). Everything is filtered here
  // rather than trusted at the draw site.
  it("drops any telegraph that would poison the canvas", () => {
    const bad = [
      null,
      telegraph({ x: NaN }),
      telegraph({ y: undefined }),
      telegraph({ radius: "big" }),
      telegraph({ radius: 0 }),        // zero-area: nothing to draw
      telegraph({ radius: -80 }),      // ellipse() THROWS on a negative radius
      telegraph({ radius: Infinity }),
    ];
    expect(telegraphsFromFrame({ telegraphs: bad })).toEqual([]);
  });

  it("keeps the good telegraphs in a mixed frame", () => {
    const out = telegraphsFromFrame({ telegraphs: [telegraph({ x: NaN }), telegraph({ x: 5 }), telegraph({ radius: 0 })] });
    expect(out).toHaveLength(1);
    expect(out[0].x).toBe(5);
  });

  // A negative or NaN `ms` would invert or delete the fill.
  it("clamps a junk `ms` to 0 rather than passing it to the fill progress", () => {
    for (const ms of [-100, NaN, undefined, "soon"]) {
      const [t] = telegraphsFromFrame({ telegraphs: [telegraph({ ms })] });
      expect(t.ms).toBe(0);
      expect(Number.isFinite(t.ms)).toBe(true);
    }
  });

  // telegraphMs (the ORIGINAL duration) is what makes progress computable
  // without a clock synced to the moment the telegraph started -- a junk
  // value falls back to `ms` (reads as "just started"), never to 0 (which
  // would divide-by-zero at the draw site).
  it("falls back telegraphMs to a safe positive value, never 0", () => {
    const [t1] = telegraphsFromFrame({ telegraphs: [telegraph({ telegraphMs: NaN, ms: 300 })] });
    expect(t1.telegraphMs).toBe(300);
    const [t2] = telegraphsFromFrame({ telegraphs: [telegraph({ telegraphMs: undefined, ms: 0 })] });
    expect(t2.telegraphMs).toBeGreaterThan(0);
  });

  it("every numeric field returned is finite", () => {
    for (const t of telegraphsFromFrame({ telegraphs: [telegraph(), telegraph({ skill: null, creatureId: null })] })) {
      for (const [k, val] of Object.entries(t)) {
        if (k === "skill" || k === "creatureId" || k === "v") continue;
        expect(Number.isFinite(val)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// THE GUARD FOR THE SOMET-523 CLASS OF BUG, mirrored from worldWaves.test.js.
//
// The aura ring shipped invisible because the server sent a field, the
// renderer drew it, and the client's state layer never named it. There are
// THREE places a snapshot field can be lost: world.snapshot() (builds it),
// server.js's frame (copies it per socket, from a NAMED FIELD LIST, not a
// spread), and the client's mapper (reads it). This checks all three.
// ---------------------------------------------------------------------------
describe("server telegraph frame -> client contract", () => {
  it("the client reads the top-level `telegraphs` key the authority sends", () => {
    const candidates = [
      "/backend/src/authority/world.js",
      path.resolve(HERE, "../../../../../../../backend/src/authority/world.js"),
      path.resolve(HERE, "../../../../../../../../backend/src/authority/world.js"),
      path.resolve(process.cwd(), "../backend/src/authority/world.js"),
      path.resolve(process.cwd(), "backend/src/authority/world.js"),
    ];
    const worldPath = candidates.find((p) => fs.existsSync(p));
    if (!worldPath) {
      throw new Error("cannot find the authority -- this guard "
        + "fails rather than skipping, because a guard that skips is worse than none");
    }
    const world = fs.readFileSync(worldPath, "utf8");
    const snapshot = world.slice(world.indexOf("  snapshot() {"));
    expect(snapshot).toMatch(/\btelegraphs:\s*this\.activeTelegraphs\b/);

    const serverPath = path.resolve(HERE, "../../../../../../../../backend/src/authority/server.js");
    const server = fs.readFileSync(serverPath, "utf8");
    expect(server).toMatch(/frame\.telegraphs\s*=\s*snap\.telegraphs/);

    const gamePath = path.resolve(HERE, "../Game.js");
    const game = fs.readFileSync(gamePath, "utf8");
    expect(game).toMatch(/telegraphsFromFrame\(\s*msg\s*\)/);

    // Every field the authority puts on a telegraph must be named by the
    // mapper, or it is dropped silently on the way to the draw path.
    const block = snapshot.slice(snapshot.indexOf("telegraphs: this.activeTelegraphs"));
    const sent = [...new Set(
      [...block.slice(0, 400).matchAll(/([a-zA-Z_][\w]*)\s*:/g)].map((m) => m[1]),
    )].filter((f) => !["telegraphs", "map"].includes(f));
    const mapper = fs.readFileSync(path.resolve(HERE, "../worldTelegraphs.js"), "utf8");
    const missing = sent.filter((f) => !new RegExp(`\\b${f}\\b`).test(mapper));
    expect(missing).toEqual([]);
  });
});
