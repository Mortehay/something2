import { describe, it, expect } from "vitest";
import { CreatureManager } from "../CreatureManager.js";

// SOMET-354. The broadcast frame is no longer a full record per creature: the
// immutable fields arrive once, and creatures outside the detail zone carry
// position only. These tests pin the difference between a field that was
// OMITTED and one that was CLEARED -- the whole correctness question, and the
// one a passing render would hide, because a creature with `maxHp: undefined`
// still draws (with a broken health bar) and a creature whose effects were
// silently wiped still draws (untinted).

const ENTITY_TYPES = {
  Wolf: { render_mode: "animated", image: "sprites/objects/Wolf/static.png", display_width: 72, display_height: 96 },
};

const intro = { id: "c1", type: "Wolf", x: 10, y: 20, facing: "S", hp: 5, maxHp: 12, mode: "idle", color: "#888" };

describe("CreatureManager partial snapshots", () => {
  it("keeps the immutable fields when later frames omit them", () => {
    const cm = new CreatureManager(ENTITY_TYPES);
    cm.applySnapshot([intro]);
    // Every later frame for this socket: position + volatile fields only.
    cm.applySnapshot([{ id: "c1", x: 30, y: 40, facing: "N", hp: 4, mode: "chase" }]);

    const c = cm.all()[0];
    expect(c.type).toBe("Wolf");
    expect(c.color).toBe("#888");
    expect(c.maxHp).toBe(12);        // a health bar divides by this
    expect(c.hp).toBe(4);            // still updated
    expect(c.facing).toBe("N");
    expect(c.tx).toBe(30);
  });

  it("holds facing/hp/mode/effects for a far creature instead of clearing them", () => {
    const cm = new CreatureManager(ENTITY_TYPES);
    cm.applySnapshot([{ ...intro, effects: ["chill"] }]);
    // Far record: position, flagged, nothing else.
    cm.applySnapshot([{ id: "c1", x: 900, y: 900, f: 1 }]);

    const c = cm.all()[0];
    expect(c.tx).toBe(900);
    expect(c.facing).toBe("S");
    expect(c.hp).toBe(5);
    expect(c.mode).toBe("idle");
    expect(c.effects).toEqual(["chill"]);
  });

  it("still clears an expired effect for a NEAR creature", () => {
    // The other side of the same coin. If the `f` guard were applied to every
    // record, an effect would never expire on screen.
    const cm = new CreatureManager(ENTITY_TYPES);
    cm.applySnapshot([{ ...intro, effects: ["chill"] }]);
    cm.applySnapshot([{ id: "c1", x: 10, y: 20, facing: "S", hp: 5, mode: "idle" }]);
    expect(cm.all()[0].effects).toBeNull();
  });

  it("accepts a first sighting that arrives in the far zone", () => {
    // A chunk can activate with creatures already far from the player, so the
    // introduction itself can be a far record: immutable fields, no facing/hp.
    const cm = new CreatureManager(ENTITY_TYPES);
    cm.applySnapshot([{ id: "c9", type: "Wolf", x: 900, y: 900, maxHp: 12, level: 3, color: "#888", f: 1 }]);

    const c = cm.all()[0];
    expect(c.type).toBe("Wolf");
    expect(c.color).toBe("#888");    // the minimap dot needs exactly this
    expect(c.facing).toBe("S");      // defaulted, not undefined
    expect(c.mode).toBe("idle");
    expect(c.hp).toBe(12);           // full until told otherwise
    expect(c.render_mode).toBe("animated");  // type visuals still applied
  });

  it("re-applies the immutable fields when a creature is re-introduced", () => {
    const cm = new CreatureManager(ENTITY_TYPES);
    cm.applySnapshot([intro]);
    cm.applySnapshot([]);                    // left the neighbourhood -> deleted
    expect(cm.count()).toBe(0);
    cm.applySnapshot([{ ...intro, x: 77 }]); // server re-introduces in full

    const c = cm.all()[0];
    expect(c.type).toBe("Wolf");
    expect(c.maxHp).toBe(12);
    expect(c.x).toBe(77);
  });

  it("applies a level of 0 rather than declining it as falsy", () => {
    const cm = new CreatureManager(ENTITY_TYPES);
    cm.applySnapshot([{ ...intro, level: 4 }]);
    cm.applySnapshot([{ id: "c1", x: 10, y: 20, facing: "S", hp: 5, mode: "idle", level: 0, maxHp: 0 }]);
    expect(cm.all()[0].level).toBe(0);
    expect(cm.all()[0].maxHp).toBe(0);
  });
});
