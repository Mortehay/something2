import { describe, it, expect, vi } from "vitest";
import { Game } from "../Game.js";
import { RenderSystem } from "../../systems/RenderSystem.js";
import { buildTravelList } from "../../../../waypointTravel.js";

function game() {
  const g = Object.create(Game.prototype);
  g.teleportCast = null;
  g.teleportPending = null;
  g.sent = [];
  g.authorityClient = {
    sendTeleportCast: () => { g.sent.push("cast"); },
    sendTeleportCancel: () => { g.sent.push("cancel"); },
  };
  g._otherPanelOpen = () => false;
  g._showToast = vi.fn();
  return g;
}

describe("teleport cast (client)", () => {
  it("T asks the server; the bar starts only when the server confirms", () => {
    const g = game();
    g.startTeleportCast();
    expect(g.sent).toEqual(["cast"]);
    expect(g.teleportCast).toBeNull();
    g._onTeleportFrame({ type: "teleportCastStarted", durationMs: 2500 });
    expect(g.teleportCast.durationMs).toBe(2500);
  });

  it("does not start while another window is open or a cast is already running", () => {
    const g = game();
    g._otherPanelOpen = () => true;
    g.startTeleportCast();
    expect(g.sent).toEqual([]);
    const h = game();
    h.teleportCast = { startedAt: 0, durationMs: 2500 };
    h.startTeleportCast();
    expect(h.sent).toEqual([]);
  });

  it("cancelling clears the bar and tells the server", () => {
    const g = game();
    g._onTeleportFrame({ type: "teleportCastStarted", durationMs: 2500 });
    g.cancelTeleportCast();
    expect(g.teleportCast).toBeNull();
    expect(g.sent).toEqual(["cancel"]);
  });

  it("a cancel that beats the server's started answer is replayed once it arrives", () => {
    const g = game();
    g.startTeleportCast();
    g.cancelTeleportCast();
    g._onTeleportFrame({ type: "teleportCastStarted", durationMs: 2500 });
    expect(g.teleportCast).toBeNull();
    expect(g.sent).toEqual(["cast", "cancel", "cancel"]);
  });

  it("an interruption by the server hides the bar and says why", () => {
    const g = game();
    g._onTeleportFrame({ type: "teleportCastStarted", durationMs: 2500 });
    g._onTeleportFrame({ type: "teleportCancelled", reason: "hurt" });
    expect(g.teleportCast).toBeNull();
    expect(g._showToast).toHaveBeenCalledWith("Teleport interrupted: you took damage");
  });

  it("completion hands over to the destination menu", () => {
    const g = game();
    g.onTeleportReady = vi.fn();
    g._onTeleportFrame({ type: "teleportCastStarted", durationMs: 2500 });
    g._onTeleportFrame({ type: "teleportReady", ticketMs: 60000 });
    expect(g.teleportCast).toBeNull();
    expect(g.onTeleportReady).toHaveBeenCalled();
  });
});

describe("teleport cast bar and destination menu", () => {
  it("the bar fills with elapsed time", () => {
    const fills = [];
    const ctx = {
      save() {}, restore() {}, fillRect: (x, y, w) => fills.push(w), strokeRect() {}, strokeText() {}, fillText() {},
    };
    const rs = Object.create(RenderSystem.prototype);
    rs.ctx = ctx;
    const player = { x: 0, y: 0, width: 64, height: 64 };
    rs.drawTeleportCastBar({ startedAt: performance.now() - 1250, durationMs: 2500 }, player);
    const filled = fills[fills.length - 1];
    expect(filled).toBeGreaterThan(25);
    expect(filled).toBeLessThan(35);
  });

  it("after a completed cast every lit waypoint is selectable from open ground", () => {
    const waypoints = [
      { id: "a", worldId: "w1", worldName: "One", x: 100, y: 100, name: "A", activated: true },
      { id: "b", worldId: "w2", worldName: "Two", x: 100, y: 100, name: "B", activated: true },
      { id: "c", worldId: "w2", worldName: "Two", x: 900, y: 900, name: "C", activated: false },
    ];
    const base = { waypoints, currentWorldId: "w1", playerX: 5000, playerY: 5000 };
    const closed = buildTravelList(base);
    expect(closed.groups.flatMap((g) => g.entries).some((e) => e.selectable)).toBe(false);
    const open = buildTravelList({ ...base, teleportReady: true });
    const sel = open.groups.flatMap((g) => g.entries).filter((e) => e.selectable).map((e) => e.id);
    expect(sel).toEqual(["a", "b"]); // the unlit one stays unselectable
  });
});
