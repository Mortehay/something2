import { describe, it, expect } from "vitest";
import { CreatureManager } from "../CreatureManager.js";

// vitest runs in a plain node environment here -- no DOM. These are
// pure-function tests over the snapshot mapping, not rendering tests.
describe("creature level", () => {
  it("carries level from the snapshot onto a newly seen creature", () => {
    const m = new CreatureManager({});
    m.applySnapshot([{ id: "a", type: "Wolf", x: 10, y: 10, facing: "S", hp: 21, maxHp: 21, level: 6, color: "#c00" }]);
    expect(m.creatures.get("a").level).toBe(6);
  });

  it("updates level on an already-known creature", () => {
    // Levels do not change in A1, but the update path must not silently drop
    // the field -- a creature re-sent after a chunk reload would lose its
    // label while keeping its scaled hp, which reads as a rendering bug.
    const m = new CreatureManager({});
    m.applySnapshot([{ id: "a", type: "Wolf", x: 10, y: 10, facing: "S", hp: 21, maxHp: 21, level: 6, color: "#c00" }]);
    m.applySnapshot([{ id: "a", type: "Wolf", x: 12, y: 10, facing: "E", hp: 18, maxHp: 21, level: 6, color: "#c00" }]);
    expect(m.creatures.get("a").level).toBe(6);
  });

  it("leaves level undefined when the server does not send one", () => {
    const m = new CreatureManager({});
    m.applySnapshot([{ id: "b", type: "Wolf", x: 0, y: 0, facing: "S", hp: 10, maxHp: 10, color: "#c00" }]);
    expect(m.creatures.get("b").level).toBeUndefined();
  });
});
