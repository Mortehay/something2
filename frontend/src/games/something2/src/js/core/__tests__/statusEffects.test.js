import { describe, it, expect } from "vitest";
import {
  EFFECT_ELEMENT,
  EFFECT_ORDER,
  normalizeEffects,
  effectColor,
  effectHudLine,
} from "../statusEffects.js";
import { elementColor } from "../blasts.js";

describe("statusEffects", () => {
  it("maps every effect key the server can send", () => {
    // These three strings are the server's BURN / CHILL / SHOCK constants
    // (backend/src/authority/effects.js). They are a wire contract: if the
    // server gains a fourth rider and this table is not updated, that effect
    // is invisible in the client. Pinning the exact set makes the omission a
    // failing test rather than a silent gap.
    expect(Object.keys(EFFECT_ELEMENT).sort()).toEqual(["burn", "chill", "shock"]);
    expect(EFFECT_ELEMENT).toEqual({ burn: "fire", chill: "ice", shock: "lightning" });
    expect(EFFECT_ORDER.slice().sort()).toEqual(Object.keys(EFFECT_ELEMENT).sort());
  });

  it("reuses the projectile/blast palette rather than a second one", () => {
    // The whole point of routing through elementColor: a burn tint and the
    // fire bolt that caused it must be the same orange. This fails the moment
    // somebody hardcodes a colour in statusEffects.js.
    expect(effectColor("burn")).toBe(elementColor("fire"));
    expect(effectColor("chill")).toBe(elementColor("ice"));
    expect(effectColor("shock")).toBe(elementColor("lightning"));
  });

  it("gives the three effects visibly distinct colours", () => {
    // A palette where two effects resolve to the same swatch is a palette that
    // conveys nothing — the indicator would be present and useless, which is
    // the failure mode this slice keeps hitting.
    const colors = EFFECT_ORDER.map(effectColor);
    expect(new Set(colors).size).toBe(EFFECT_ORDER.length);
    for (const c of colors) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("orders effects deterministically regardless of server iteration order", () => {
    // The server iterates a Map, so key order is insertion order and varies
    // with which effect landed first. Without this the HUD line and the ring
    // order would reshuffle between frames on the same set of effects.
    expect(normalizeEffects(["shock", "burn", "chill"])).toEqual(["burn", "chill", "shock"]);
    expect(normalizeEffects(["chill", "shock"])).toEqual(["chill", "shock"]);
    expect(normalizeEffects(["shock", "chill"])).toEqual(["chill", "shock"]);
  });

  it("drops an unknown key instead of painting it a default colour", () => {
    // A wrong tint is worse than no tint: a future 'poison' rendered in
    // lightning yellow reads to the player as a shock, and they act on it.
    expect(normalizeEffects(["burn", "poison"])).toEqual(["burn"]);
    expect(effectColor("poison")).toBeNull();
    expect(effectHudLine(["poison"])).toBeNull();
  });

  it("treats a missing/empty effects field as no effects", () => {
    // The server OMITS the field entirely when nothing is active, so
    // `undefined` is the overwhelmingly common input here, not a bug.
    for (const input of [undefined, null, [], "burn", 0]) {
      expect(normalizeEffects(input)).toEqual([]);
      expect(effectHudLine(input)).toBeNull();
    }
  });

  it("builds a HUD line naming what each effect does, or null to draw nothing", () => {
    expect(effectHudLine(["burn"])).toBe("Burning");
    // Labels say the EFFECT, not the wire key: "Slowed" tells the player why
    // they are not outrunning anything; "chill" does not.
    expect(effectHudLine(["chill"])).toBe("Slowed");
    expect(effectHudLine(["shock", "burn"])).toBe("Burning  Shocked");
    // null rather than "" so the caller omits the row entirely — an empty
    // string would still push the HUD panel a row taller.
    expect(effectHudLine([])).toBeNull();
  });
});
