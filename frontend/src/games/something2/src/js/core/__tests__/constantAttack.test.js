// SOMET-494 — the two rules that decide whether a held button keeps attacking.
//
// Both failure directions are covered deliberately: a hold that stops when it
// should not makes the option look broken, and a hold that keeps going when it
// should not is a stuck auto-attack the player cannot end without reloading.
import { describe, it, expect } from "vitest";
import {
  shouldRepeatAttack, refusalStopsHold, CONSTANT_ATTACK_INTERVAL_MS,
} from "../constantAttack.js";

// Every field true/ready, so each test can negate exactly one thing and know
// that is what caused the answer.
const READY = { enabled: true, held: true, playing: true, panelOpen: false, lastSentAt: 0 };
const LATER = CONSTANT_ATTACK_INTERVAL_MS;

describe("shouldRepeatAttack", () => {
  it("repeats once the interval has elapsed", () => {
    expect(shouldRepeatAttack(READY, LATER)).toBe(true);
  });

  it("does not repeat before the interval has elapsed", () => {
    expect(shouldRepeatAttack(READY, LATER - 1)).toBe(false);
  });

  it("refuses when the setting is off", () => {
    expect(shouldRepeatAttack({ ...READY, enabled: false }, LATER)).toBe(false);
  });

  it("refuses when the button is not held", () => {
    expect(shouldRepeatAttack({ ...READY, held: false }, LATER)).toBe(false);
  });

  it("refuses when not in a playing world", () => {
    // Covers a dead socket and a torn-down world as one condition: Game builds
    // `playing` from state + chunked + a live authority client.
    expect(shouldRepeatAttack({ ...READY, playing: false }, LATER)).toBe(false);
  });

  it("refuses while a panel owns the cursor", () => {
    expect(shouldRepeatAttack({ ...READY, panelOpen: true }, LATER)).toBe(false);
  });

  it("fires on the very first tick of a hold that has never sent", () => {
    // A hold whose lastSentAt is absent must not wait a full interval for its
    // first repeat -- and must not throw on the arithmetic either.
    expect(shouldRepeatAttack({ ...READY, lastSentAt: undefined }, 0)).toBe(true);
  });

  it("survives a missing state object", () => {
    expect(shouldRepeatAttack(null, 0)).toBe(false);
  });

  it("ticks faster than the fastest weapon in the catalog can fire", () => {
    // The client deliberately does not know the real cooldown (it depends on a
    // server-side cooldownMult passive), so it must never be the limiting
    // factor. The fastest weapon ships a 0.25s cooldown.
    expect(CONSTANT_ATTACK_INTERVAL_MS).toBeLessThan(250);
  });
});

describe("refusalStopsHold", () => {
  it("stops on a resource refusal", () => {
    // The whole promise of the option: run out, and the character stops.
    expect(refusalStopsHold("resource")).toBe(true);
  });

  it("does NOT stop on a cooldown refusal", () => {
    // A held button is refused for cooldown many times a second. Stopping on
    // that would make the option fire exactly once and then look broken.
    expect(refusalStopsHold("cooldown")).toBe(false);
  });

  it("does NOT stop on a shock interrupt", () => {
    // Temporary: the player should resume swinging when it expires rather than
    // having to notice and re-press.
    expect(refusalStopsHold("interrupted")).toBe(false);
  });

  it("does not stop on an unrecognised or absent reason", () => {
    // Fail OPEN. A reason this client does not know is far more likely to be a
    // newer server than a resource that ran out, and stopping on it would end
    // holds for no reason the player can see.
    expect(refusalStopsHold("unarmed")).toBe(false);
    expect(refusalStopsHold(undefined)).toBe(false);
    expect(refusalStopsHold(null)).toBe(false);
  });
});
