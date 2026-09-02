import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { wavesFromFrame } from "../worldWaves.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const wave = (over = {}) => ({
  x: 100, y: 200, nx: 1, ny: 0, reach: 190, arc: 1.8, el: "fire", ms: 1500, ...over,
});

describe("wavesFromFrame", () => {
  it("carries the resolved geometry through to the renderer", () => {
    const [w] = wavesFromFrame({ waves: [wave()] });
    expect(w).toEqual({ x: 100, y: 200, nx: 1, ny: 0, reach: 190, arc: 1.8, el: "fire", ms: 1500 });
  });

  // The server OMITS the key entirely when there are no waves, which is the
  // overwhelmingly common case. That must be an empty list, not a crash in the
  // socket handler.
  it("collapses an absent or malformed frame to empty", () => {
    for (const msg of [{}, { waves: null }, { waves: "no" }, undefined, null]) {
      expect(wavesFromFrame(msg)).toEqual([]);
    }
  });

  // Canvas 2D SILENTLY DROPS a path with non-finite coordinates -- no error,
  // nothing drawn, and depending on ordering it can take the rest of the pass
  // with it. Everything is filtered here rather than trusted at the draw site.
  it("drops any wave that would poison the canvas", () => {
    const bad = [
      null,
      wave({ x: NaN }),
      wave({ y: undefined }),
      wave({ nx: "east" }),
      wave({ reach: 0 }),          // zero-area path
      wave({ reach: -190 }),       // ellipse() THROWS on a negative radius
      wave({ arc: 0 }),
      wave({ arc: -1 }),
      wave({ reach: Infinity }),
    ];
    expect(wavesFromFrame({ waves: bad })).toEqual([]);
  });

  it("keeps the good waves in a mixed frame", () => {
    const out = wavesFromFrame({ waves: [wave({ x: NaN }), wave({ x: 5 }), wave({ arc: 0 })] });
    expect(out).toHaveLength(1);
    expect(out[0].x).toBe(5);
  });

  // A negative or NaN lifetime would invert or delete the fade.
  it("clamps a junk lifetime to 0 rather than passing it to the alpha", () => {
    for (const ms of [-100, NaN, undefined, "soon"]) {
      const [w] = wavesFromFrame({ waves: [wave({ ms })] });
      expect(w.ms).toBe(0);
      expect(Number.isFinite(w.ms)).toBe(true);
    }
  });

  it("every returned value is finite", () => {
    for (const w of wavesFromFrame({ waves: [wave(), wave({ el: null })] })) {
      for (const [k, v] of Object.entries(w)) {
        if (k === "el") continue;
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// THE GUARD FOR THE SOMET-523 CLASS OF BUG.
//
// The aura ring shipped invisible because the server sent a field, the renderer
// drew it, and the client's state layer never named it. worldPlayers.test.js
// guards that for PER-PLAYER fields. Waves are a TOP-LEVEL frame key, which
// that test's `out.<field> =` scan does not reach -- so this is its sibling.
// ---------------------------------------------------------------------------
describe("server wave frame -> client contract", () => {
  it("the client reads the top-level `waves` key the authority sends", () => {
    const worldPath = path.resolve(HERE, "../../../../../../../../backend/src/authority/world.js");
    if (!fs.existsSync(worldPath)) {
      throw new Error(`cannot find the authority at ${worldPath} -- this guard `
        + "fails rather than skipping, because a guard that skips is worse than none");
    }
    const world = fs.readFileSync(worldPath, "utf8");
    const snapshot = world.slice(world.indexOf("  snapshot() {"));
    // The authority attaches it as `waves: this.waves.map(...)`.
    expect(snapshot).toMatch(/\bwaves:\s*this\.waves\b/);

    // THE HOP I MISSED, and it is why this feature reached the browser dead.
    //
    // There are THREE places a snapshot field can be lost, not two:
    //   1. world.snapshot()      builds it            (checked above)
    //   2. server.js's frame     copies it per socket (checked here)
    //   3. the client's mapper   reads it             (checked below)
    //
    // Hop 2 assembles the frame from a NAMED FIELD LIST -- `{ type, tick,
    // ackSeq, players: snap.players, projectiles: snap.projectiles }` -- not a
    // spread. The authority emitted `waves`, worldWaves.js read `waves`, both
    // had passing unit tests, and the frame in between silently dropped it.
    const serverPath = path.resolve(HERE, "../../../../../../../../backend/src/authority/server.js");
    const server = fs.readFileSync(serverPath, "utf8");
    expect(server).toMatch(/frame\.waves\s*=\s*snap\.waves/);

    // And the client must actually read it off the frame.
    const gamePath = path.resolve(HERE, "../Game.js");
    const game = fs.readFileSync(gamePath, "utf8");
    expect(game).toMatch(/wavesFromFrame\(\s*msg\s*\)/);

    // Every field the authority puts on a wave must be named by the mapper,
    // or it is dropped silently on the way to the draw path.
    const waveBlock = snapshot.slice(snapshot.indexOf("waves: this.waves"));
    const sent = [...new Set(
      [...waveBlock.slice(0, 400).matchAll(/([a-zA-Z_][\w]*)\s*:/g)].map((m) => m[1]),
    )].filter((f) => !["waves", "map"].includes(f));
    const mapper = fs.readFileSync(path.resolve(HERE, "../worldWaves.js"), "utf8");
    const missing = sent.filter((f) => !new RegExp(`\\b${f}\\b`).test(mapper));
    expect(missing).toEqual([]);
  });
});
