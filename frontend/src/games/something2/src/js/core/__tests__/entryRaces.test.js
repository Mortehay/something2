// SOMET-742. Entering a world waits on images, long enough for a newer entry or a
// destroy() to arrive meanwhile. A superseded run must stop, open no socket, and
// never tear down the entry that replaced it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const clients = vi.hoisted(() => ({ made: [] }));
vi.mock("../../net/WorldAuthorityClient.js", () => ({
  WorldAuthorityClient: class {
    constructor(opts) { this.opts = opts; this.connect = vi.fn(); this.disconnect = vi.fn(); clients.made.push(this); }
  },
}));
vi.mock("../../net/auth.js", async (original) => ({
  ...(await original()),
  getStoredToken: () => "token",
  parseJwt: () => ({ user_id: 1 }),
}));

import { Game } from "../Game.js";

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
  g.preloadSprites = () => {};
  g.imageManager.loadAll = () => {};
  return g;
}

const enter = (g) => g.initChunked({ worldId: 1, characterId: 1, chunkSize: 16, tileTypes: {} });
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("Game.initChunked superseded runs", () => {
  let waits;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      addEventListener: vi.fn(), removeEventListener: vi.fn(), innerWidth: 1280, innerHeight: 720,
      location: { protocol: "http:", host: "localhost", hostname: "localhost" },
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    clients.made = [];
    waits = [];
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const heldArt = (g) => {
    g.imageManager.whenSettled = () => new Promise((resolve) => { waits.push(() => resolve({ timedOut: false })); });
  };

  it("destroy during the art wait opens no socket and reports not entered", async () => {
    const g = makeGame();
    heldArt(g);
    const run = enter(g);
    await flush();
    g.destroy();
    waits[0]();
    expect(await run).toBe(false);
    expect(clients.made).toHaveLength(0);
  });

  it("a newer entry during the art wait: only the newer one connects", async () => {
    const g = makeGame();
    heldArt(g);
    const first = enter(g);
    await flush();
    enter(g).catch(() => {});
    await flush();
    waits[0]();
    expect(await first).toBe(false);
    expect(clients.made).toHaveLength(0);
    waits[1]();
    await flush();
    expect(clients.made).toHaveLength(1);
  });

  it("a superseded run's join timeout does not abort the newer entry", async () => {
    const g = makeGame();
    g.imageManager.whenSettled = () => Promise.resolve({ timedOut: false });
    const first = enter(g); // connects, and its join never answers
    await flush();
    expect(clients.made).toHaveLength(1);
    heldArt(g);
    enter(g).catch(() => {}); // the newer entry, still waiting on art
    await flush();
    const state = g.state;
    await vi.advanceTimersByTimeAsync(5000);
    expect(await first).toBe(false);
    expect(g.state).toBe(state);
  });

  it("a run with no rival still reports a failed join to its caller", async () => {
    const g = makeGame();
    g.imageManager.whenSettled = () => Promise.resolve({ timedOut: false });
    const run = enter(g).then(() => "resolved", (e) => e.message);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await run).toBe("authority join timeout");
    expect(g.state).not.toBe("playing");
  });
});
