// SOMET-656 — the Game wiring that feeds box-sheet action playback, against a
// real Game instance. The pure halves (sheetActions, EntityAnimState) are
// pinned elsewhere; this pins that they are CONNECTED to the wire.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Game } from "../Game.js";
import { EntityAnimState } from "../../systems/entityAnimState.js";
import { CreatureManager } from "../../entities/CreatureManager.js";

const realWindow = globalThis.window;
const realPerf = globalThis.performance;
let clock = 0;

function makeGame() {
  const g = new Game();
  g.state = "playing";
  g.localUserId = "me";
  g.player = { x: 0, y: 0, width: 64, height: 64, hp: 10, maxHp: 10 };
  g._inputBuffer = [];
  g.chunkedMap = null;
  g.entityAnim = new EntityAnimState(); // initChunked's job in the live game
  return g;
}

const me = (over = {}) => ({ id: "me", x: 0, y: 0, hp: 10, maxHp: 10, ...over });
const other = (over = {}) => ({ id: "u7", x: 50, y: 50, hp: 10, maxHp: 10, ...over });

beforeEach(() => {
  clock = 1000;
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
  globalThis.performance = { now: () => clock };
});

afterEach(() => {
  globalThis.window = realWindow;
  globalThis.performance = realPerf;
});

describe("world-state frames feed the anim state", () => {
  it("notes attacks (cast on a full circle) and impacts by actor", () => {
    const g = makeGame();
    g.creatures = new CreatureManager();
    g.creatures.applySnapshot([5, 6, 9].map((id) => ({ id, type: "Wolf", x: 0, y: 0, facing: "S", hp: 10 })));
    g._onWorldState({
      tick: 1, players: [me(), other()],
      attacks: [
        { a: "c:5", v: "bite", x: 0, y: 0, arc: 1.2 },
        { a: "c:6", v: "slam", x: 0, y: 0, arc: Math.PI * 2 },
      ],
      impacts: [{ t: "p:me", x: 0, y: 0 }, { t: "c:9", x: 0, y: 0 }],
    });
    expect(g.entityAnim.stateFor("c:5").attackAt).toBe(1000);
    expect(g.entityAnim.stateFor("c:6").castAt).toBe(1000);
    expect(g.entityAnim.stateFor("self").hitAt).toBe(1000);
    expect(g.entityAnim.stateFor("c:9").hitAt).toBe(1000);
  });

  it("a remote player's hp drop is a hit; leaving the frame forgets them", () => {
    const g = makeGame();
    g._onWorldState({ tick: 1, players: [me(), other()] });
    clock = 2000;
    g._onWorldState({ tick: 2, players: [me(), other({ hp: 6 })] });
    expect(g.entityAnim.stateFor("p:u7").hitAt).toBe(2000);
    g._onWorldState({ tick: 3, players: [me()] });
    expect(g.entityAnim.stateFor("p:u7")).toBe(null);
  });

  it("the local player's hp drop is a hit on 'self'", () => {
    const g = makeGame();
    clock = 3000;
    g._onWorldState({ tick: 1, players: [me({ hp: 4 })] });
    expect(g.entityAnim.stateFor("self").hitAt).toBe(3000);
  });

  it("does nothing (and does not throw) before a world has been entered", () => {
    const g = makeGame();
    g.entityAnim = null;
    expect(() => g._onWorldState({ tick: 1, players: [me({ hp: 4 }), other()], attacks: [{ a: "c:1", arc: 1 }] }))
      .not.toThrow();
  });
});

describe("the local player's own attack plays at send time", () => {
  it("_sendAttackAtCursor notes a swing on 'self'", () => {
    const g = makeGame();
    g.camera = { screenX: 0, screenY: 0 };
    g.canvas = { width: 1280, height: 720 };
    g.authorityClient = { sendAttack: () => {} };
    clock = 4000;
    g._sendAttackAtCursor();
    expect(g.entityAnim.stateFor("self").attackAt).toBe(4000);
  });
});

describe("creature manager callbacks", () => {
  it("a creature hp drop is a hit and keeps the existing damage callback; removal forgets", () => {
    const g = makeGame();
    const m = new CreatureManager();
    const floated = [];
    m.onCreatureDamage = (c, dmg) => floated.push([c.id, dmg]);
    g._bindCreatureAnim(m);
    m.applySnapshot([{ id: 5, type: "Wolf", x: 0, y: 0, facing: "S", hp: 10 }]);
    clock = 5000;
    m.applySnapshot([{ id: 5, type: "Wolf", x: 0, y: 0, facing: "S", hp: 7 }]);
    expect(g.entityAnim.stateFor("c:5").hitAt).toBe(5000);
    expect(floated).toEqual([[5, 3]]);
    m.applySnapshot([]);
    expect(g.entityAnim.stateFor("c:5")).toBe(null);
  });
});

describe("SOMET-656 fix round wiring", () => {
  it("constant attack (send every 50 ms) cycles through the swing, not frame 0", () => {
    const g = makeGame();
    g.camera = { screenX: 0, screenY: 0 };
    g.canvas = { width: 1280, height: 720 };
    g.authorityClient = { sendAttack: () => {} };
    const starts = new Set();
    for (clock = 1000; clock < 2000; clock += 50) {
      g._sendAttackAtCursor();
      const r = g.entityAnim.stateFor("self");
      r.attackDurMs = 500;
      starts.add(r.attackAt);
    }
    expect(starts.size).toBe(2);
  });

  it("world-wide events for actors the client does not track leave no record", () => {
    const g = makeGame();
    g.creatures = new CreatureManager();
    g.creatures.applySnapshot([{ id: 5, type: "Wolf", x: 0, y: 0, facing: "S", hp: 10 }]);
    g._onWorldState({
      tick: 1, players: [me(), other()],
      attacks: [{ a: "c:5", arc: 1 }, { a: "c:99", arc: 1 }, { a: "p:far", arc: 1 }],
      impacts: [{ t: "p:u7" }, { t: "p:ghost" }],
    });
    expect(g.entityAnim.stateFor("c:5")).not.toBe(null);
    expect(g.entityAnim.stateFor("c:99")).toBe(null);
    expect(g.entityAnim.stateFor("p:far")).toBe(null);
    expect(g.entityAnim.stateFor("p:ghost")).toBe(null);
    expect(g.entityAnim.stateFor("p:u7")).not.toBe(null);
  });

  it("a state frame sweeps stale records", () => {
    const g = makeGame();
    g.entityAnim.noteAttack("c:old", 0, false);
    clock = 20000;
    g._onWorldState({ tick: 1, players: [me()] });
    expect(g.entityAnim.stateFor("c:old")).toBe(null);
  });

  it("a remote player's skill-use sfx casts", () => {
    const g = makeGame();
    g._onWorldState({ tick: 1, players: [me(), other()], sfx: [{ e: "use", s: "skill:bolt", a: "p:u7" }] });
    expect(g.entityAnim.stateFor("p:u7").castAt).toBe(1000);
  });
});
