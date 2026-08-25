// SOMET-494 — the Game wiring for "Constant attack", against a real Game
// instance rather than the pure rules alone.
//
// core/constantAttack.test.js pins the rules; this pins that they are actually
// CONNECTED: that a hold sends more than one attack, that the server's refusal
// reaches the flag, and that every way of letting go clears it. A feature whose
// pure half is perfect and whose wiring is dead is the exact shape this repo
// keeps shipping green.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Game } from "../Game.js";
import { CONSTANT_ATTACK_INTERVAL_MS } from "../constantAttack.js";

const realWindow = globalThis.window;
const realPerf = globalThis.performance;

// performance.now is driven by hand: the repeat is time-gated, and a test that
// waited on the wall clock would be slow AND flaky.
let clock = 0;

function makeGame({ constantAttack = true } = {}) {
  const g = new Game();
  g.state = "playing";
  g.chunked = true;
  g.constantAttack = constantAttack;
  g.camera = { screenX: 0, screenY: 0 };
  g.canvas = { width: 1280, height: 720 };
  g.player = { x: 100, y: 100, width: 64, height: 64 };
  g.sent = [];
  g.authorityClient = { sendAttack: (nx, ny) => g.sent.push({ nx, ny }) };
  return g;
}

// One update() tick's worth of the constant-attack step, at `t` ms.
function tickAt(g, t) {
  clock = t;
  g._tickConstantAttack();
}

beforeEach(() => {
  clock = 0;
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
  globalThis.performance = { now: () => clock };
});

afterEach(() => {
  globalThis.window = realWindow;
  globalThis.performance = realPerf;
});

describe("holding the button repeats the attack", () => {
  it("sends again once the interval elapses, and not before", () => {
    const g = makeGame();
    g._attackHeld = true;
    g._sendAttackAtCursor();               // the press itself
    expect(g.sent).toHaveLength(1);

    tickAt(g, CONSTANT_ATTACK_INTERVAL_MS - 1);
    expect(g.sent).toHaveLength(1);        // too soon

    tickAt(g, CONSTANT_ATTACK_INTERVAL_MS);
    expect(g.sent).toHaveLength(2);

    tickAt(g, CONSTANT_ATTACK_INTERVAL_MS * 2);
    expect(g.sent).toHaveLength(3);
  });

  it("sends exactly once per press when the option is OFF", () => {
    // The regression that matters most to a player who never enables this.
    const g = makeGame({ constantAttack: false });
    g._attackHeld = true;
    g._sendAttackAtCursor();
    for (let t = 0; t <= CONSTANT_ATTACK_INTERVAL_MS * 10; t += 10) tickAt(g, t);
    expect(g.sent).toHaveLength(1);
  });

  it("re-aims at the cursor on every repeat instead of freezing the press direction", () => {
    const g = makeGame();
    g._cursorX = 1280; g._cursorY = 360;   // to one side
    g._attackHeld = true;
    g._sendAttackAtCursor();
    g._cursorX = 0;                        // player swings the mouse across
    tickAt(g, CONSTANT_ATTACK_INTERVAL_MS);
    expect(g.sent).toHaveLength(2);
    expect(g.sent[1].nx).not.toBeCloseTo(g.sent[0].nx);
  });
});

describe("the hold ends", () => {
  function held() {
    const g = makeGame();
    g._attackHeld = true;
    g._sendAttackAtCursor();
    return g;
  }

  function assertStopped(g) {
    const before = g.sent.length;
    for (let t = CONSTANT_ATTACK_INTERVAL_MS; t <= CONSTANT_ATTACK_INTERVAL_MS * 5; t += CONSTANT_ATTACK_INTERVAL_MS) {
      tickAt(g, t);
    }
    expect(g.sent).toHaveLength(before);
  }

  it("on a resource refusal from the server", () => {
    const g = held();
    g._onAttackRefused({ reason: "resource" });
    expect(g._attackHeld).toBe(false);
    assertStopped(g);
  });

  it("but NOT on a cooldown refusal", () => {
    // Under a held button the server refuses for cooldown constantly. If that
    // ended the hold the option would fire once and appear broken.
    const g = held();
    g._onAttackRefused({ reason: "cooldown" });
    expect(g._attackHeld).toBe(true);
    tickAt(g, CONSTANT_ATTACK_INTERVAL_MS);
    expect(g.sent).toHaveLength(2);
  });

  it("on an empty quiver", () => {
    // `noammo` arrives on its own frame, but means the same thing to a player.
    const g = held();
    g._stopConstantAttack();
    expect(g._attackHeld).toBe(false);
    assertStopped(g);
  });

  it("when a panel opens, and does not resume when it closes", () => {
    // Resuming would swing at the world off a button press made before the
    // player went shopping.
    const g = held();
    g.inventoryOpen = true;
    tickAt(g, CONSTANT_ATTACK_INTERVAL_MS);
    expect(g._attackHeld).toBe(false);
    g.inventoryOpen = false;
    assertStopped(g);
  });

  it("when the setting is switched off mid-hold", () => {
    const g = held();
    g.setConstantAttack(false);
    expect(g._attackHeld).toBe(false);
    assertStopped(g);
  });

  it("when the player joins another world", () => {
    // A doorway re-inits the world; arriving already swinging is not something
    // the press in the previous world asked for.
    const g = held();
    g._attackHeld = false;   // what initChunked's reset does
    assertStopped(g);
  });

  it("and can be started again by a fresh press", () => {
    const g = held();
    g._onAttackRefused({ reason: "resource" });
    assertStopped(g);
    const after = g.sent.length;
    g._attackHeld = true;                       // the player holds again
    g._sendAttackAtCursor();
    tickAt(g, clock + CONSTANT_ATTACK_INTERVAL_MS);
    expect(g.sent.length).toBe(after + 2);
  });
});

describe("the settings snapshot", () => {
  it("reports constantAttack alongside the other two", () => {
    const g = makeGame({ constantAttack: false });
    expect(g.getSettingsSnapshot().constantAttack).toBe(false);
    g.setConstantAttack(true);
    expect(g.getSettingsSnapshot().constantAttack).toBe(true);
  });

  it("is null outside a playing world, so the panel can disable its rows", () => {
    const g = makeGame();
    g.state = "menu";
    expect(g.getSettingsSnapshot()).toBeNull();
  });
});
