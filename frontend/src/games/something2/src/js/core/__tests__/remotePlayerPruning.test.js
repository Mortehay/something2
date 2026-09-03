// SOMET-365 — a player absent from a state frame must actually disappear.
//
// The server now scopes the player broadcast to the recipient's chunk
// neighbourhood, so a remote player LEAVING a frame is no longer a rare event
// at disconnect: it is what happens every time someone walks away. That turns
// Game._onWorldState's rebuild from incidental behaviour into a load-bearing
// one, and nothing pinned it.
//
// The failure it guards against is a ghost: a frozen sprite of someone who
// walked off, standing there until reload. Anyone later "optimising"
// _onWorldState into an incremental update (patch the players present, leave
// the rest) reintroduces exactly that, and would otherwise do it green.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Game } from "../Game.js";

const realWindow = globalThis.window;

function makeGame() {
  const g = new Game();
  g.state = "playing";
  g.localUserId = "me";
  // _onWorldState reconciles the local player out of the frame, so the
  // prediction inputs it needs are supplied rather than stubbed away -- the
  // local-player leg runs for real, which is what makes the last test below
  // (the local row must not land among the remote ones) meaningful.
  g.player = { x: 0, y: 0, width: 64, height: 64 };
  g._inputBuffer = [];
  g.chunkedMap = null;
  return g;
}

const frame = (players) => ({ tick: 1, players });

beforeEach(() => {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
});

afterEach(() => {
  globalThis.window = realWindow;
});

describe("remote player pruning (SOMET-365)", () => {
  it("drops a player who is absent from the next frame", () => {
    const g = makeGame();
    g._onWorldState(frame([
      { id: "me", x: 0, y: 0, hp: 10, maxHp: 10 },
      { id: "other", x: 50, y: 50, hp: 10, maxHp: 10 },
    ]));
    expect(g.remotePlayers.has("other")).toBe(true);

    // "other" walked out of the neighbourhood: the server simply stops
    // including them. No explicit leave message exists, and none should be
    // needed.
    g._onWorldState(frame([{ id: "me", x: 0, y: 0, hp: 10, maxHp: 10 }]));
    expect(g.remotePlayers.has("other")).toBe(false);
    expect(g.remotePlayers.size).toBe(0);
  });

  it("brings a player back when they re-enter the neighbourhood", () => {
    const g = makeGame();
    g._onWorldState(frame([{ id: "me", x: 0, y: 0, hp: 10, maxHp: 10 }]));
    expect(g.remotePlayers.size).toBe(0);

    g._onWorldState(frame([
      { id: "me", x: 0, y: 0, hp: 10, maxHp: 10 },
      { id: "other", x: 70, y: 70, hp: 7, maxHp: 10 },
    ]));
    expect(g.remotePlayers.get("other").x).toBe(70);
    expect(g.remotePlayers.get("other").hp).toBe(7);
  });

  // The control. Without it, a _onWorldState that cleared the map and added
  // nothing would pass the pruning test above perfectly — and delete every
  // other player from the game.
  it("keeps the players who ARE present, and updates them in place", () => {
    const g = makeGame();
    g._onWorldState(frame([
      { id: "me", x: 0, y: 0, hp: 10, maxHp: 10 },
      { id: "a", x: 10, y: 10, hp: 10, maxHp: 10 },
      { id: "b", x: 20, y: 20, hp: 10, maxHp: 10 },
    ]));
    expect([...g.remotePlayers.keys()].sort()).toEqual(["a", "b"]);

    g._onWorldState(frame([
      { id: "me", x: 0, y: 0, hp: 10, maxHp: 10 },
      { id: "a", x: 999, y: 111, hp: 4, maxHp: 10 },
    ]));
    expect([...g.remotePlayers.keys()]).toEqual(["a"]);
    expect(g.remotePlayers.get("a").x).toBe(999);
    expect(g.remotePlayers.get("a").hp).toBe(4);
  });

  // The recipient is never a remote player, however the server scopes the
  // frame -- its row is reconciled into g.player instead. A regression here
  // would draw the local player twice, once interpolated and once not.
  it("never files the local player among the remote ones", () => {
    const g = makeGame();
    g._onWorldState(frame([{ id: "me", x: 5, y: 6, hp: 8, maxHp: 10 }]));
    expect(g.remotePlayers.has("me")).toBe(false);
    expect(g.player.hp).toBe(8);
  });
});
