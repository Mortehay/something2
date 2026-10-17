// SOMET-622: the game's keydown listener is on window, so it also receives
// keys typed into admin form fields rendered while the game is mounted. A
// digit typed into an input was consumed by the hotbar ("s4_mire" saved as
// "s_mire"). Keys aimed at an editable element must not reach the game.
import { describe, it, expect, beforeEach } from "vitest";
import { Game } from "../Game.js";

function makeTestGame() {
  const canvas = {
    width: 800,
    height: 600,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const g = new Game(canvas);
  g.setupInput();
  g.state = "playing";
  g.chunked = true;
  g.authorityClient = { sendCastSkill: () => {}, sendInteract: () => {} };
  g.player = { x: 100, y: 100, width: 32, height: 32, hp: 100, maxHp: 100 };
  return g;
}

function keyEvent(key, code, target) {
  const ev = { key, code, repeat: false, target, defaultPrevented: false };
  ev.preventDefault = () => { ev.defaultPrevented = true; };
  return ev;
}

const EDITABLE_TARGETS = {
  input: { tagName: "INPUT" },
  textarea: { tagName: "TEXTAREA" },
  select: { tagName: "SELECT" },
  contenteditable: { tagName: "DIV", isContentEditable: true },
};

describe("game keydown ignores editable targets (SOMET-622)", () => {
  let g;
  let activated;

  beforeEach(() => {
    g = makeTestGame();
    activated = [];
    g._activateHotbarSkill = (slot) => { activated.push(slot); };
  });

  for (const [name, target] of Object.entries(EDITABLE_TARGETS)) {
    it(`a digit typed into a ${name} does not trigger a hotbar slot or get swallowed`, () => {
      const ev = keyEvent("4", "Digit4", target);
      g._keydownHandler(ev);
      expect(activated).toEqual([]);
      expect(ev.defaultPrevented).toBe(false);
      expect(g.keys["4"]).toBeFalsy();
    });
  }

  it("movement and panel hotkeys typed into an input do not register", () => {
    g._keydownHandler(keyEvent("w", "KeyW", EDITABLE_TARGETS.input));
    g._keydownHandler(keyEvent("k", "KeyK", EDITABLE_TARGETS.input));
    expect(g.keys.w).toBeFalsy();
    expect(g.skillsOpen).toBe(false);
  });

  it("control: the same digit on a non-editable target still triggers the slot", () => {
    const ev = keyEvent("4", "Digit4", { tagName: "CANVAS" });
    g._keydownHandler(ev);
    expect(activated).toEqual([4]);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("control: an event with no target still triggers the slot", () => {
    g._keydownHandler(keyEvent("4", "Digit4", undefined));
    expect(activated).toEqual([4]);
  });
});
