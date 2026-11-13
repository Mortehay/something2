// Slice 2 of the image shrink: only HOSTILE creature art loads on demand.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const clients = vi.hoisted(() => ({ made: [] }));
vi.mock("../../net/WorldAuthorityClient.js", () => ({
  WorldAuthorityClient: class {
    constructor(opts) { this.opts = opts; this.connect = vi.fn(); this.disconnect = vi.fn(); clients.made.push(this); }
  },
}));
vi.mock("../../net/ChunkStreamer.js", () => ({
  ChunkStreamer: class { constructor() { this.loadCenter = async () => true; this.update = () => {}; this.isLoadedAt = () => true; } },
}));
vi.mock("../../net/auth.js", async (original) => ({
  ...(await original()),
  getStoredToken: () => "token",
  parseJwt: () => ({ user_id: 1 }),
}));

import { Game } from "../Game.js";
import { CreatureManager } from "../../entities/CreatureManager.js";

const types = () => ({
  Wolf: { isCreature: true, faction: "hostile", image: "w" },
  Guard: { isCreature: true, faction: "guard", image: "g" },
  Merchant: { isCreature: false, pointKind: "merchant", image: "m" },
  Tree: { isCreature: false, image: "t" },
  Hero: { isCreature: false, image: "h" },
});

const stubCtx = () => new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => ({ addColorStop() {} })), set: (t, k, v) => { t[k] = v; return true; } });

function makeGame() {
  const g = new Game();
  g.canvas = {
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
    getContext: () => stubCtx(), width: 1280, height: 720,
  };
  g.ctx = stubCtx();
  g.loadQuests = () => Promise.resolve();
  g._refreshProgressionBundle = () => {};
  g._preloadTileAssets = () => {};
  g.imageManager.loadAll = () => {};
  g.imageManager.load = vi.fn(() => Promise.resolve());
  return g;
}
const loaded = (g) => g.imageManager.load.mock.calls.map((c) => c[0]);

describe("hostile creature art on demand", () => {
  it("preloadSprites skips hostile creatures", async () => {
    const g = makeGame();
    await g.preloadSprites(types());
    expect(loaded(g).sort()).toEqual(["g", "h", "m", "t"]);
  });

  it("first snapshot of a type loads its art once", () => {
    const g = makeGame();
    g._entityTypes = types();
    g.creatures = new CreatureManager(g._entityTypes, { onType: (n) => g.ensureEntityArt(n) });
    g.creatures.applySnapshot([{ id: 1, type: "Wolf", x: 0, y: 0 }]);
    g.creatures.applySnapshot([{ id: 1, type: "Wolf", x: 1, y: 0 }, { id: 2, type: "Wolf", x: 5, y: 0 }]);
    expect(loaded(g).filter((k) => k === "w")).toHaveLength(1);
  });

  it("a non-hostile type seen in a snapshot is not loaded again (preloaded)", async () => {
    const g = makeGame();
    g._entityTypes = types();
    await g.preloadSprites(g._entityTypes);
    g.creatures = new CreatureManager(g._entityTypes, { onType: (n) => g.ensureEntityArt(n) });
    g.creatures.applySnapshot([{ id: 1, type: "Guard", x: 0, y: 0 }, { id: 2, type: "Merchant", x: 1, y: 0 }]);
    await g.ensureEntityArt("Tree");
    expect(loaded(g).filter((k) => k === "g")).toHaveLength(1);
    expect(loaded(g).filter((k) => k === "m")).toHaveLength(1);
    expect(loaded(g).filter((k) => k === "t")).toHaveLength(1);
  });

  describe("entry", () => {
    beforeEach(() => {
      clients.made = [];
      vi.stubGlobal("window", {
        addEventListener: vi.fn(), removeEventListener: vi.fn(), innerWidth: 1280, innerHeight: 720,
        location: { protocol: "http:", host: "localhost", hostname: "localhost" },
      });
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
      vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
      for (const m of ["warn", "error", "log"]) vi.spyOn(console, m).mockImplementation(() => {});
    });
    afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

    it("nearby entry wait covers creatures in the snapshot, loaded before the wait", async () => {
      const g = makeGame();
      const waits = [];
      g.imageManager.whenSettled = (names) => {
        waits.push({ names, loadedWolf: loaded(g).includes("w") });
        return Promise.resolve({ timedOut: false });
      };
      const run = g.initChunked({ worldId: 1, characterId: 1, chunkSize: 16, tileTypes: {}, entityTypes: types() });
      for (let i = 0; i < 50 && !clients.made.length; i++) await Promise.resolve();
      const c = clients.made[clients.made.length - 1];
      c.opts.onJoined({ spawn: { x: 0, y: 0 } });
      c.opts.onCreatures({ creatures: [{ id: 1, type: "Wolf", x: 10, y: 10 }] });
      await run.catch(() => {});
      const nearby = waits.find((w) => w.names.includes("w"));
      expect(nearby).toBeTruthy();
      expect(nearby.loadedWolf).toBe(true);
    });
  });
});
