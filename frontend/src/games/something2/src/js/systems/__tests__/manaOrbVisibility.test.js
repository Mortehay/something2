import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RenderSystem } from "../RenderSystem.js";

// SOMET-472 -- a Cultist pays every mana cost in HP, so the mana orb has to be
// GONE, not empty.
//
// The plan for this task said "renderHud already omits the MP line when mana
// is null". That was true of an older text HUD and is false of the orb HUD on
// main: _drawPoEOrb reads a null `current` as 0 and a null `max` as 100, so
// passing nulls paints a permanently EMPTY blue orb -- which reads as "you are
// out of mana", the opposite of the truth. The silent-skip shape this epic
// keeps shipping. Hence an explicit flag, and hence this file.

function hudWithOrbSpy(props) {
  const rs = Object.create(RenderSystem.prototype);
  const orbs = [];
  rs._drawPoEOrb = (cx, cy, radius, current, max, label, colorType) => {
    orbs.push({ kind: "single", label, current, max, colorType });
  };
  rs._drawPoEDualOrb = (cx, cy, radius, manaCurrent, manaMax, staminaCurrent, staminaMax) => {
    orbs.push({ kind: "dual", label: "MP/SP", manaCurrent, manaMax, staminaCurrent, staminaMax });
  };
  rs._drawXpBar = () => {};
  rs.renderHud({ player: { hp: 42, maxHp: 110 }, ...props });
  return orbs;
}

describe("renderHud resource orbs", () => {
  it("draws HP orb and dual MP/SP orb for an ordinary mana class", () => {
    const orbs = hudWithOrbSpy({ mana: 30, maxMana: 100, stamina: 80, maxStamina: 100, showMana: true });
    expect(orbs.map((o) => o.label)).toEqual(["HP", "MP/SP"]);
    expect(orbs[1]).toEqual({
      kind: "dual",
      label: "MP/SP",
      manaCurrent: 30,
      manaMax: 100,
      staminaCurrent: 80,
      staminaMax: 100,
    });
  });

  it("still draws dual orb when showMana is not supplied at all", () => {
    const orbs = hudWithOrbSpy({ mana: 30, maxMana: 100, stamina: 50, maxStamina: 100 });
    expect(orbs.map((o) => o.label)).toEqual(["HP", "MP/SP"]);
  });

  it("draws SP (stamina) orb for a life-cost class (Cultist), instead of MP", () => {
    const orbs = hudWithOrbSpy({ mana: 90, maxMana: 90, stamina: 75, maxStamina: 100, showMana: false });
    expect(orbs.map((o) => o.label)).toEqual(["HP", "SP"]);
    expect(orbs[0]).toEqual({ kind: "single", label: "HP", current: 42, max: 110, colorType: "life" });
    expect(orbs[1]).toEqual({ kind: "single", label: "SP", current: 75, max: 100, colorType: "stamina" });
  });
});

// The flag has to travel: server `joined` frame -> Game.usesLifeCost ->
// renderChunked's showMana. A renderHud test alone would pass against a Game
// that never sets it, which is exactly how six items in this epic shipped inert.
describe("Game.js wires usesLifeCost from the join frame to the HUD", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(
    path.join(here, "..", "..", "core", "Game.js"), "utf8");

  it("reads the flag off the joined frame, strictly", () => {
    expect(src).toMatch(/this\.usesLifeCost = msg\.usesLifeCost === true;/);
  });

  it("hides the orb from that flag rather than nulling the pool", () => {
    expect(src).toMatch(/showMana: !this\.usesLifeCost,/);
    // The pool itself keeps flowing; only the orb is suppressed. Blanking
    // localMana instead would break any other readout that ever reads it.
    expect(src).toMatch(/mana: this\.localMana,/);
  });
});
