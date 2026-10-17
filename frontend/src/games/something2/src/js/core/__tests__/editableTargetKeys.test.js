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

// Review of 830de7f1: the in-game Settings overlay has checkboxes and range
// sliders, and the game keeps running behind it. A click leaves focus on the
// control, so a guard matching every INPUT froze WASD/hotbar until the player
// clicked elsewhere. Only text-entry inputs own the keyboard.
describe("non-text inputs do not block game keys (SOMET-622 review)", () => {
  let g;
  let activated;

  beforeEach(() => {
    g = makeTestGame();
    activated = [];
    g._activateHotbarSkill = (slot) => { activated.push(slot); };
  });

  for (const type of ["checkbox", "range", "radio", "button", "submit", "reset", "color", "image", "file"]) {
    it(`W and 4 still reach the game while a ${type} input has focus`, () => {
      const target = { tagName: "INPUT", type };
      g._keydownHandler(keyEvent("w", "KeyW", target));
      g._keydownHandler(keyEvent("4", "Digit4", target));
      expect(g.keys.w).toBe(true);
      expect(activated).toEqual([4]);
    });
  }

  for (const type of ["text", "number", "search", "email", "password", "url", "tel", "TEXT"]) {
    it(`a ${type} input still owns the digit`, () => {
      const ev = keyEvent("4", "Digit4", { tagName: "INPUT", type });
      g._keydownHandler(ev);
      expect(activated).toEqual([]);
      expect(ev.defaultPrevented).toBe(false);
    });
  }
});
