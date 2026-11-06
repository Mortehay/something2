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

  describe("the join timer", () => {
    // At 2 Mbps the server has answered within a second but its joined frame is
    // still arriving; that is a slow link, not a dead socket.
    const failedAt = async (g, afterConnect) => {
      g.imageManager.whenSettled = () => Promise.resolve({ timedOut: false });
      let failed = null;
      enter(g).catch((e) => { failed = e.message; });
      await flush();
      afterConnect(clients.made[0]);
      return () => failed;
    };

    it("a silent socket fails at 5 s", async () => {
      const failed = await failedAt(makeGame(), () => {});
      await vi.advanceTimersByTimeAsync(4999);
      expect(failed()).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(failed()).toBe("authority join timeout");
    });

    it("a socket the server has answered gets longer, but not forever", async () => {
      const failed = await failedAt(makeGame(), (c) => { c.opts.onFrame(); c.opts.onFrame(); });
      await vi.advanceTimersByTimeAsync(29999);
      expect(failed()).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(failed()).toBe("authority join timeout");
    });

    it("a kick during the join fails it at once", async () => {
      const failed = await failedAt(makeGame(), (c) => { c.opts.onFrame(); c.opts.onKicked(); });
      await flush();
      expect(failed()).toBe("Signed in elsewhere — this session was disconnected.");
    });

    it("a socket that answered and then died is back on the short limit", async () => {
      const failed = await failedAt(makeGame(), (c) => { c.opts.onFrame(); c.opts.onClose({}, false); });
      await vi.advanceTimersByTimeAsync(4999);
      expect(failed()).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(failed()).toBe("authority join timeout");
    });

    it("a retry the reconnect guard gave up on is back on the short limit", async () => {
      const g = makeGame();
      const failed = await failedAt(g, (c) => { c.opts.onFrame(); });
      g.state = "playing"; // a map change: the only join that can reach the reconnect loop
      clients.made[0].worldId = 1;
      clients.made[0].characterId = 1;
      clients.made[0].opts.onClose({}, false);
      await vi.advanceTimersByTimeAsync(1000); // the retry's backoff
      expect(clients.made[0].connect).toHaveBeenCalledTimes(2);
      clients.made[0].opts.onFrame();
      await vi.advanceTimersByTimeAsync(8000); // the guard closes that socket on purpose
      expect(clients.made[0].disconnect).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(4999);
      expect(failed()).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(failed()).toBe("authority join timeout");
    });

    it("the replacement socket answering extends the limit again", async () => {
      const failed = await failedAt(makeGame(), (c) => { c.opts.onFrame(); c.opts.onClose({}, false); c.opts.onFrame(); });
      await vi.advanceTimersByTimeAsync(29999);
      expect(failed()).toBeNull();
    });
  });

  describe("image downloads during the join", () => {
    // On a slow link, downloads held the joined frame past the join timer: 4 of 6
    // fresh entries failed at 4 Mbps. In-flight images may finish; nothing new starts.
    let started;
    beforeEach(() => {
      started = [];
      vi.stubGlobal("Image", class { set src(v) { started.push(this); } });
    });
    const queued = (g, n) => { for (let i = 0; i < n; i++) g.imageManager.load(`art${i}`, `/art${i}.png`); };
    const artDone = (g) => { g.imageManager.whenSettled = () => Promise.resolve({ timedOut: false }); };

    it("start nothing new until the join ends in a timeout, then carry on", async () => {
      const g = makeGame();
      artDone(g);
      queued(g, 8);
      expect(started).toHaveLength(6);
      const run = enter(g).catch((e) => e.message);
      await flush();
      expect(clients.made).toHaveLength(1);
      started[0].onload();
      expect(started).toHaveLength(6);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await run).toBe("authority join timeout");
      expect(started).toHaveLength(7);
    });

    it("carry on once the join succeeds", async () => {
      const g = makeGame();
      artDone(g);
      queued(g, 8);
      let failure = null;
      enter(g).catch((e) => { failure = e; });
      await flush();
      started[0].onload();
      expect(started).toHaveLength(6);
      clients.made[0].opts.onJoined({ spawn: { x: 0, y: 0 } });
      await flush();
      expect(started).toHaveLength(7);
      expect(failure).toBeNull();
    });

    it("a newer entry waiting on art is not left with a paused queue", async () => {
      const g = makeGame();
      artDone(g);
      queued(g, 8);
      enter(g).catch(() => {});
      await flush();
      expect(clients.made).toHaveLength(1);
      heldArt(g);
      enter(g).catch(() => {});
      await flush();
      started[0].onload();
      expect(started).toHaveLength(7);
    });

    it("a newer entry that stops early does not leave the queue paused", async () => {
      const g = makeGame();
      artDone(g);
      queued(g, 8);
      enter(g).catch(() => {});
      await flush();
      g.canvas = null;
      expect(await enter(g)).toBe(false);
      started[0].onload();
      expect(started).toHaveLength(7);
    });

    it("a superseded join ending does not lift the newer join's pause", async () => {
      const g = makeGame();
      artDone(g);
      queued(g, 8);
      enter(g).catch(() => {});
      await flush();
      await vi.advanceTimersByTimeAsync(2000);
      enter(g).catch(() => {});
      await flush();
      expect(clients.made).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(3100); // the first join's timer fires; the second's has not
      started[0].onload();
      expect(started).toHaveLength(6);
    });
  });
});
