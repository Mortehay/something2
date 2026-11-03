import { describe, it, expect } from "vitest";
import {
  getBuildGuide, resolvePlan, buildProgress, hotbarStatus, currentMilestone,
  loadFollowing, saveFollowing, followStorageKey, UPCOMING_STEPS,
} from "../buildGuide.js";
import { buildTreeIndex } from "../../systems/passiveTreePanel.js";

// A straight corridor  start(1) - 2 - 3 - 4 - 5 - 6 - 7 - 8 - 9  plus a side branch 3 - 20.
function tree() {
  const nodes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 20].map((id) => ({
    id, key: id === 1 ? "start" : `n${id}`, label: `Node ${id}`, kind: "minor", x: id * 10, y: 0, sector: "core", grants: [],
  }));
  const edges = [[1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9], [3, 20]];
  return buildTreeIndex({ nodes, edges });
}
const step = (id, kind = "minor") => ({ key: `n${id}`, label: `Node ${id}`, kind });
const GUIDE = {
  className: "Tester", name: "Test Build", summary: "s", playstyle: "p", stats: [], hotbar: [], earlySkills: [],
  passives: {
    startKey: "start",
    steps: [2, 3, 4, 5, 6, 7, 8, 9].map((i) => step(i)),
    milestones: [{ points: 3, summary: "early" }, { points: 8, summary: "late" }],
    keystones: [],
  },
  gear: [], weaknesses: [],
};

describe("getBuildGuide", () => {
  it("finds a class case-insensitively and returns null for unknown / empty", () => {
    const guides = { Warrior: GUIDE };
    expect(getBuildGuide("warrior", guides)).toBe(GUIDE);
    expect(getBuildGuide("  WARRIOR ", guides)).toBe(GUIDE);
    expect(getBuildGuide("Bard", guides)).toBeNull();
    expect(getBuildGuide(null, guides)).toBeNull();
    expect(getBuildGuide("", guides)).toBeNull();
  });
});

describe("resolvePlan", () => {
  it("maps stable keys to this tree's ids and reports keys the tree lacks", () => {
    const index = tree();
    const g = { ...GUIDE, passives: { ...GUIDE.passives, steps: [step(2), { key: "gone", label: "Gone", kind: "minor" }, step(3)] } };
    const plan = resolvePlan(g, index);
    expect(plan.startId).toBe(1);
    expect(plan.stepIds).toEqual([2, null, 3]);
    expect(plan.missing).toEqual(["gone"]);
    expect(plan.total).toBe(3);
  });
  it("returns null without a guide or a tree", () => {
    expect(resolvePlan(null, tree())).toBeNull();
    expect(resolvePlan(GUIDE, null)).toBeNull();
  });
});

describe("buildProgress", () => {
  const index = tree();
  const plan = resolvePlan(GUIDE, index);

  it("a fresh character: nothing taken, the first step is next", () => {
    const p = buildProgress(plan, index, [], 1);
    expect(p.done).toBe(0);
    expect(p.total).toBe(8);
    expect(p.nextIndex).toBe(0);
    expect(p.nextId).toBe(2);
    expect(p.detour).toBe(false);
    expect(p.complete).toBe(false);
    expect(p.nextStep.label).toBe("Node 2");
  });

  it("marks the next step plus a bounded handful as upcoming, and every remaining step as planned", () => {
    const p = buildProgress(plan, index, [2, 3], 1);
    expect(p.done).toBe(2);
    expect(p.nextId).toBe(4);
    expect([...p.upcomingIds]).toEqual([4, 5, 6, 7, 8].slice(0, UPCOMING_STEPS));
    expect([...p.plannedIds].sort((a, b) => a - b)).toEqual([4, 5, 6, 7, 8, 9]);
    expect(p.upcomingSteps[0]).toMatchObject({ n: 3, label: "Node 4" });
    expect(p.takenKeys).toEqual(new Set(["n2", "n3"]));
  });

  it("counts off-route nodes and does not count the start node as one", () => {
    const p = buildProgress(plan, index, [2, 3, 20], 1);
    expect(p.done).toBe(2);
    expect(p.offPlan).toBe(1);
    expect(buildProgress(plan, index, [2], 1).offPlan).toBe(0);
  });

  it("when the player skipped ahead and the next step is not adjacent, points at the first node of the way back", () => {
    // Owns 2 and 3 plus the far node 8 reached some other way; next unallocated is 4 (adjacent): normal.
    expect(buildProgress(plan, index, [2, 3, 8], 1).detour).toBe(false);
    // Owns only the side branch beside 3, not 2 or 3 -- but with start 1 owned the first step 2 is adjacent.
    // Build a case where it is not: a plan whose first step is two hops from anything owned.
    const far = resolvePlan({ ...GUIDE, passives: { ...GUIDE.passives, steps: [step(4), step(5)] } }, index);
    const p = buildProgress(far, index, [], 1);
    expect(p.nextStep.label).toBe("Node 4");
    expect(p.detour).toBe(true);
    expect(p.nextId).toBe(2); // the first node on the way to 4
  });

  it("is complete (and has no next) once every step is taken", () => {
    const p = buildProgress(plan, index, [2, 3, 4, 5, 6, 7, 8, 9], 1);
    expect(p.complete).toBe(true);
    expect(p.nextId).toBeNull();
    expect(p.nextIndex).toBe(-1);
    expect(p.done).toBe(8);
  });

  it("ignores steps the tree does not have instead of stalling on them", () => {
    const g = { ...GUIDE, passives: { ...GUIDE.passives, steps: [{ key: "gone", label: "Gone", kind: "minor" }, step(2)] } };
    const p = buildProgress(resolvePlan(g, index), index, [], 1);
    expect(p.nextId).toBe(2);
    expect(p.total).toBe(2);
  });

  it("returns null with no plan", () => {
    expect(buildProgress(null, index, [], 1)).toBeNull();
  });
});

describe("hotbarStatus / currentMilestone", () => {
  it("flags which recommended skills are already owned", () => {
    const g = { ...GUIDE, hotbar: [{ slot: 1, skillId: "a" }, { slot: 2, skillId: "b" }] };
    expect(hotbarStatus(g, new Set(["b"])).map((h) => h.owned)).toEqual([false, true]);
    expect(hotbarStatus(g, ["a"]).map((h) => h.owned)).toEqual([true, false]);
    expect(hotbarStatus(null, new Set())).toEqual([]);
  });
  it("picks the next unreached milestone, or the last when past them all", () => {
    expect(currentMilestone(GUIDE, 0).points).toBe(3);
    expect(currentMilestone(GUIDE, 3).points).toBe(8);
    expect(currentMilestone(GUIDE, 50).points).toBe(8);
    expect(currentMilestone({ passives: { milestones: [] } }, 1)).toBeNull();
  });
});

describe("follow switch persistence", () => {
  function fakeStorage(initial = {}) {
    const m = new Map(Object.entries(initial));
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
  }
  it("is per character and off by default", () => {
    const s = fakeStorage();
    expect(loadFollowing(7, s)).toBe(false);
    saveFollowing(7, true, s);
    expect(loadFollowing(7, s)).toBe(true);
    expect(loadFollowing(8, s)).toBe(false);
    saveFollowing(7, false, s);
    expect(loadFollowing(7, s)).toBe(false);
    expect(s.m.has(followStorageKey(7))).toBe(false);
  });
  it("survives blocked storage", () => {
    const blocked = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() { throw new Error("denied"); } };
    expect(loadFollowing(1, blocked)).toBe(false);
    expect(() => saveFollowing(1, true, blocked)).not.toThrow();
    expect(loadFollowing(1, null)).toBe(false);
  });
});
