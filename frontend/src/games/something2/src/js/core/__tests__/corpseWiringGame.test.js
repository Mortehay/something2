// Death animation wiring against a real Game instance: the world-state
// frame's death sfx + the creature leaving the snapshot leave a corpse; the
// pure lifecycle is pinned in systems/__tests__/corpses.test.js.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Game } from "../Game.js";
import { EntityAnimState } from "../../systems/entityAnimState.js";
import { CreatureManager } from "../../entities/CreatureManager.js";

const realWindow = globalThis.window;
const realPerf = globalThis.performance;
let clock = 0;

const DIRS = ["s", "se", "e", "ne", "n", "nw", "w", "sw"];
function sheet(actions) {
  const rows = [];
  const frames = {};
  let row = 0;
  for (const action of actions) {
    for (const direction of DIRS) {
      rows.push({ row, action, direction, frames: 4 });
      for (let i = 0; i < 4; i += 1) frames[`${action}/${direction}/${i}`] = [i * 10, row * 10, 10, 10];
      row += 1;
    }
  }
  return { version: 1, cell: [10, 10], actions, frames_per_action: 4, rows, frames };
}

function makeGame(manifest) {
  const g = new Game();
  g.state = "playing";
  g.localUserId = "me";
  g.player = { x: 0, y: 0, width: 64, height: 64, hp: 10, maxHp: 10 };
  g._inputBuffer = [];
  g.chunkedMap = null;
  g.entityAnim = new EntityAnimState();
  const types = { Wolf: { render_mode: "static", sprite: { atlas_key: "wolf", manifest } } };
  g.creatures = new CreatureManager(types);
  g._bindCreatureAnim(g.creatures);
  return g;
}

const wolf = (over = {}) => ({ id: 5, type: "Wolf", x: 100, y: 100, facing: "W", hp: 10, maxHp: 10, ...over });
const frame = (sfx) => ({ tick: 1, players: [{ id: "me", x: 0, y: 0, hp: 10, maxHp: 10 }], sfx });
const DEATH = { e: "death", c: "Wolf", x: 124, y: 124 };

beforeEach(() => {
  clock = 1000;
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
  globalThis.performance = { now: () => clock };
});

afterEach(() => {
  globalThis.window = realWindow;
  globalThis.performance = realPerf;
});

describe("creature death -> corpse", () => {
  it("a death sfx then the creature leaving the snapshot leaves a corpse where it fell", () => {
    const g = makeGame(sheet(["idle", "death"]));
    g.creatures.applySnapshot([wolf()]);
    g._onWorldState(frame([DEATH]));
    clock = 1100;
    g.creatures.applySnapshot([]);
    const live = g.corpses.live(clock);
    expect(live.map((c) => [c.id, c.x, c.y, c.flipX])).toEqual([[5, 100, 100, true]]);
    // Not gameplay state: the creature list is empty.
    expect(g.creatures.all()).toEqual([]);
  });

  it("leaving the neighbourhood (no death sfx) leaves nothing", () => {
    const g = makeGame(sheet(["idle", "death"]));
    g.creatures.applySnapshot([wolf()]);
    g._onWorldState(frame([]));
    g.creatures.applySnapshot([]);
    expect(g.corpses.live(clock)).toEqual([]);
  });

  it("a sheet with no death row vanishes as before", () => {
    const g = makeGame(sheet(["idle"]));
    g.creatures.applySnapshot([wolf()]);
    g._onWorldState(frame([DEATH]));
    g.creatures.applySnapshot([]);
    expect(g.corpses.live(clock)).toEqual([]);
  });

  it("the same id reappearing drops the corpse", () => {
    const g = makeGame(sheet(["idle", "death"]));
    g.creatures.applySnapshot([wolf()]);
    g._onWorldState(frame([DEATH]));
    g.creatures.applySnapshot([]);
    expect(g.corpses.size).toBe(1);
    g.creatures.applySnapshot([wolf()]);
    expect(g.corpses.size).toBe(0);
  });
});

describe("the snapshot neighbourhood (chunked world)", () => {
  // chunkSize 16 x MAP_TILE_SIZE 100: the player at (0,0) sees x/y in [-1600, 3200).
  it("a creature dropped by a chunk crossing, next to an out-of-AOI same-type death, leaves no corpse", () => {
    const g = makeGame(sheet(["idle", "death"]));
    g.chunkedMap = { chunkSize: 16 };
    g.creatures.applySnapshot([wolf({ x: 3150, y: 100 })]);
    g.creatures.applySnapshot([wolf({ x: 3210, y: 100 })]); // target now past the edge
    g._onWorldState(frame([{ e: "death", c: "Wolf", x: 3260, y: 124 }]));
    g.creatures.applySnapshot([]);
    expect(g.corpses.live(clock)).toEqual([]);
  });
  it("an in-AOI death still leaves a corpse", () => {
    const g = makeGame(sheet(["idle", "death"]));
    g.chunkedMap = { chunkSize: 16 };
    g.creatures.applySnapshot([wolf()]);
    g._onWorldState(frame([DEATH]));
    g.creatures.applySnapshot([]);
    expect(g.corpses.live(clock).map((c) => c.id)).toEqual([5]);
  });
  it("one snapshot dropping two wolves credits the death to the nearer one", () => {
    const g = makeGame(sheet(["idle", "death"]));
    g.chunkedMap = { chunkSize: 16 };
    g.creatures.applySnapshot([wolf({ id: 1, x: 100 }), wolf({ id: 2, x: 160 })]);
    g._onWorldState(frame([{ e: "death", c: "Wolf", x: 184, y: 124 }]));
    g.creatures.applySnapshot([]);
    expect(g.corpses.live(clock).map((c) => c.id)).toEqual([2]);
  });
});

describe("the frame hands the live corpses to the renderer", () => {
  // Source gate: Game's render loop needs a canvas, a camera and a world, so
  // the one argument is checked in the source text (vitest is node-env).
  it("renderChunked is passed corpses: this.corpses.live(nowMs)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../Game.js", import.meta.url), "utf8");
    const call = src.slice(src.indexOf("this.renderSystem.renderChunked({"));
    expect(call.slice(0, 600)).toContain("corpses: this.corpses.live(nowMs),");
  });
});
