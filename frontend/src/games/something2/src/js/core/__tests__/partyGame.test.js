// The party system as the Game wires it: roster frames land in state, a remote
// caster's cast is drawn through the SAME effect path as a local cast, the
// caster's own echo is never drawn twice, and the minimap gets party markers only
// for members in this world.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Game } from "../Game.js";
import { SKILLS } from "../skillsData.js";
import { partyMarkersOf } from "../partyMarkers.js";

const realWindow = globalThis.window;
const realPerf = globalThis.performance;

const SKILL = SKILLS.find((s) => s.id === "mag_fireball") || SKILLS[0];

function makeGame() {
  const g = new Game();
  g.state = "playing";
  g.chunked = true;
  g.player = { x: 100, y: 100, width: 64, height: 64 };
  g.localUserId = "me";
  g.worldId = "w1";
  g.toasts = [];
  g.showToast = (t) => g.toasts.push(t);
  g.sent = [];
  g.authorityClient = { sendPartyInvite: (id) => g.sent.push(["invite", id]) };
  return g;
}

beforeEach(() => {
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
  globalThis.performance = { now: () => 10_000 };
});
afterEach(() => {
  globalThis.window = realWindow;
  globalThis.performance = realPerf;
});

const cast = (over = {}) => ({ s: SKILL.id, by: "mate", x: 300, y: 300, tx: 500, ty: 300, nx: 1, ny: 0, ...over });

describe("remote casts (MulticastCastSkill, receiving end)", () => {
  it("draws a party-mate's cast through the shared effect path", () => {
    const g = makeGame();
    const calls = [];
    g._spawnSkillFx = (...a) => calls.push(a);
    g._playRemoteCasts([cast()]);
    expect(calls).toHaveLength(1);
    const [skill, px, py, tx, ty, angle] = calls[0];
    expect(skill.id).toBe(SKILL.id);
    expect([px, py, tx, ty]).toEqual([300, 300, 500, 300]);
    expect(angle).toBe(0);
  });

  it("never draws the local player's own cast twice", () => {
    const g = makeGame();
    const calls = [];
    g._spawnSkillFx = (...a) => calls.push(a);
    g._playRemoteCasts([cast({ by: "me" })]);
    expect(calls).toHaveLength(0);
  });

  it("ignores an unknown skill and malformed numbers instead of throwing", () => {
    const g = makeGame();
    const calls = [];
    g._spawnSkillFx = (...a) => calls.push(a);
    g._playRemoteCasts([cast({ s: "no_such_skill" }), cast({ tx: NaN }), null]);
    expect(calls).toHaveLength(0);
  });

  it("caps how many casts one frame can draw", () => {
    const g = makeGame();
    const calls = [];
    g._spawnSkillFx = (...a) => calls.push(a);
    g._playRemoteCasts(Array.from({ length: 30 }, () => cast()));
    expect(calls).toHaveLength(8);
  });
});

describe("party state", () => {
  const party = {
    id: "p1", leaderId: "me", lootMode: "free_for_all", maxSize: 4,
    members: [
      { id: "me", name: "Me", online: true, x: 100, y: 100, w: "w1" },
      { id: "mate", name: "Mate", online: true, x: 400, y: 120, w: "w1" },
      { id: "far", name: "Far", online: true, x: 1, y: 1, w: "other-world" },
      { id: "gone", name: "Gone", online: false },
    ],
  };

  it("stores the roster and notifies the panel", () => {
    const g = makeGame();
    const seen = [];
    g.setOnPartyChange((p, inv) => seen.push([p, inv]));
    g._setPartyInvite({ fromId: "mate", fromName: "Mate" });
    g._setParty(party);
    expect(g.getParty()).toBe(party);
    expect(g.getPartyInvite()).toBeNull();
    expect(seen).toHaveLength(2);
  });

  it("minimap markers: only other members who are in this world and have a position", () => {
    const g = makeGame();
    g._setParty(party);
    expect(partyMarkersOf(g.party, g.localUserId, g.worldId)).toEqual([{ x: 400, y: 120, name: "Mate" }]);
    expect(partyMarkersOf(null, "me", "w1")).toEqual([]);
  });

  it("invite-nearest picks the closest remote player in range, else says so", () => {
    const g = makeGame();
    g.remotePlayers = new Map([["a", { x: 900, y: 100 }], ["b", { x: 300, y: 100 }]]);
    g.invitePartyNearest();
    expect(g.sent).toEqual([["invite", "b"]]);
    g.sent.length = 0;
    g.remotePlayers = new Map([["a", { x: 9000, y: 100 }]]);
    g.invitePartyNearest();
    expect(g.sent).toEqual([]);
    expect(g.toast && g.toast.message).toBeTruthy();
  });

  it("leaving shows a toast", () => {
    const g = makeGame();
    g._setParty(party);
    g._setParty(null);
    expect(g.toast && g.toast.message).toBeTruthy();
  });
});
