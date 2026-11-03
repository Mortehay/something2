import { describe, it, expect } from "vitest";
import {
  wrapText, guideContent, layoutBuildGuide, BG_TABS, BG_PANEL_W, LINE_H,
} from "../buildGuidePanel.js";
import { layoutPassiveTree, buildTreeIndex } from "../passiveTreePanel.js";
import { resolvePlan, buildProgress } from "../../core/buildGuide.js";

const GUIDE = {
  className: "Tester", name: "Test Build",
  summary: "A short summary of the build.",
  playstyle: "Run in circles. ".repeat(40),
  stats: [{ stat: "STR", why: "Hits harder." }, { stat: "DEX", why: "Attacks faster." }],
  hotbar: [
    { slot: 1, skillId: "a", name: "Alpha", unlock: "Lv 1 · 100 g", why: "Opener." },
    { slot: 2, skillId: "b", name: "Beta", unlock: "Lv 5 · 200 g", why: "Finisher." },
  ],
  earlySkills: [{ skillId: "a", name: "Alpha", level: 1, note: "Start here." }],
  passives: {
    startKey: "start",
    steps: [2, 3, 4].map((i) => ({ key: `n${i}`, label: `Node ${i}`, kind: i === 3 ? "keystone" : "minor" })),
    milestones: [{ points: 2, summary: "early game" }, { points: 4, summary: "late game" }],
    keystones: [{ key: "n3", label: "Node 3", atStep: 2, note: "Big power, big cost." }],
  },
  gear: ["Wear a sword."], weaknesses: ["Slow."],
};

function tree() {
  const nodes = [1, 2, 3, 4, 5].map((id) => ({
    id, key: id === 1 ? "start" : `n${id}`, label: `Node ${id}`, kind: id === 3 ? "keystone" : "minor",
    x: id * 40, y: 0, sector: "core", grants: [],
  }));
  return buildTreeIndex({ nodes, edges: [[1, 2], [2, 3], [3, 4], [4, 5]] });
}

describe("wrapText", () => {
  it("wraps on word boundaries within the budget and never overflows", () => {
    const lines = wrapText("the quick brown fox jumps over the lazy dog", 15);
    expect(lines.every((l) => l.length <= 15)).toBe(true);
    expect(lines.join(" ")).toBe("the quick brown fox jumps over the lazy dog");
  });
  it("splits a word longer than the budget instead of letting it overflow", () => {
    const lines = wrapText("a".repeat(40), 10);
    expect(lines.every((l) => l.length <= 10)).toBe(true);
    expect(lines.join("")).toBe("a".repeat(40));
  });
  it("keeps explicit newlines and survives empty / undefined input", () => {
    expect(wrapText("one\ntwo", 20)).toEqual(["one", "two"]);
    expect(wrapText("", 20)).toEqual([""]);
    expect(wrapText(undefined, 20)).toEqual([""]);
  });
});

describe("guideContent", () => {
  const base = { guide: GUIDE, hotbar: GUIDE.hotbar.map((h) => ({ ...h, owned: h.slot === 1 })), allocatedCount: 1 };

  it("overview: name, stats, where-you-are, and the follow hint matches the switch", () => {
    const off = guideContent({ ...base, tab: "overview", treeLoaded: false, following: false }).map((l) => l.text);
    expect(off[0]).toContain("Test Build");
    expect(off.some((t) => t.includes("1. STR - Hits harder."))).toBe(true);
    expect(off.some((t) => t.includes("Open the Passive Tree"))).toBe(true);
    expect(off.some((t) => t.includes("Follow this build"))).toBe(true);
    const on = guideContent({ ...base, tab: "overview", treeLoaded: true, following: true,
      progress: { done: 1, total: 3, offPlan: 0, complete: false, nextIndex: 1, nextStep: GUIDE.passives.steps[1] } }).map((l) => l.text);
    expect(on.some((t) => t.includes("Following is ON"))).toBe(true);
    expect(on.some((t) => t.includes("Next: step 2 - Node 3 (keystone)"))).toBe(true);
    expect(on.some((t) => t.includes("Next milestone at 2 points: early game"))).toBe(true);
  });

  it("hotbar: shows each slot with learned / not yet, the unlock line and the reason", () => {
    const t = guideContent({ ...base, tab: "hotbar" }).map((l) => l.text);
    expect(t).toContain("[1] Alpha   learned");
    expect(t).toContain("[2] Beta   not yet");
    expect(t).toContain("Lv 5 · 200 g");
    expect(t).toContain("Finisher.");
    expect(t.some((x) => x.startsWith("Lv 1  Alpha - Start here."))).toBe(true);
  });

  it("passives: lists the next steps in order with the first marked, key nodes and milestones", () => {
    const progress = {
      done: 1, total: 3, offPlan: 0, complete: false, detour: false, takenKeys: new Set(["n2"]),
      upcomingSteps: [{ n: 2, label: "Node 3", kind: "keystone" }, { n: 3, label: "Node 4", kind: "minor" }],
    };
    const t = guideContent({ ...base, tab: "passives", treeLoaded: true, progress }).map((l) => l.text);
    expect(t).toContain("> 2. Node 3 (keystone)");
    expect(t).toContain("  3. Node 4");
    expect(t).toContain("[ ] Node 3 - step 2");
    expect(t).toContain("[ ] 2 points: early game");
    expect(guideContent({ ...base, allocatedCount: 4, tab: "passives", treeLoaded: true, progress })
      .map((l) => l.text)).toContain("[x] 4 points: late game");
  });

  it("passives: a detour is explained", () => {
    const progress = { done: 0, total: 3, offPlan: 2, complete: false, detour: true, takenKeys: new Set(),
      upcomingSteps: [{ n: 1, label: "Node 2", kind: "minor" }] };
    const t = guideContent({ ...base, tab: "passives", treeLoaded: true, progress }).map((l) => l.text);
    expect(t.some((x) => x.includes("take the highlighted node first"))).toBe(true);
  });

  it("gear tab lists gear and weaknesses", () => {
    const t = guideContent({ ...base, tab: "gear" }).map((l) => l.text);
    expect(t).toContain("- Wear a sword.");
    expect(t).toContain("- Slow.");
  });

  it("no guide, no content", () => {
    expect(guideContent({ guide: null, tab: "overview" })).toEqual([]);
  });
});

describe("layoutBuildGuide", () => {
  it("offers close, one hit area per tab and the follow switch", () => {
    const l = layoutBuildGuide({ guide: GUIDE, tab: "hotbar", hotbar: [] });
    const kinds = l.hitAreas.map((a) => a.kind);
    expect(kinds.filter((k) => k === "bgtab")).toHaveLength(BG_TABS.length);
    expect(kinds).toContain("bgclose");
    expect(kinds).toContain("bgfollow");
    expect(l.tabs.find((t) => t.selected).tab).toBe("hotbar");
    expect(l.follow.on).toBe(false);
    expect(layoutBuildGuide({ guide: GUIDE, following: true }).follow.on).toBe(true);
  });

  it("an unknown tab falls back to the overview; no guide means no follow switch", () => {
    expect(layoutBuildGuide({ guide: GUIDE, tab: "nope" }).tab).toBe("overview");
    const none = layoutBuildGuide({ guide: null });
    expect(none.hasGuide).toBe(false);
    expect(none.hitAreas.some((a) => a.kind === "bgfollow")).toBe(false);
  });

  it("long text wraps inside the panel and scrolling is clamped to the content", () => {
    const l = layoutBuildGuide({ guide: GUIDE, tab: "overview", scroll: 0 });
    for (const r of l.rows) expect(r.x + r.text.length * 7.2).toBeLessThanOrEqual(l.panel.x + BG_PANEL_W);
    expect(l.totalH).toBe(l.lines.length * LINE_H);
    const past = layoutBuildGuide({ guide: GUIDE, tab: "overview", scroll: 1e6 });
    expect(past.scrollY).toBe(past.maxScroll);
    expect(layoutBuildGuide({ guide: GUIDE, tab: "overview", scroll: -50 }).scrollY).toBe(0);
  });

  it("only rows inside the visible area are returned", () => {
    const l = layoutBuildGuide({ guide: GUIDE, tab: "overview", scroll: 0 });
    for (const r of l.rows) {
      expect(r.y + LINE_H).toBeGreaterThanOrEqual(l.area.y);
      expect(r.y).toBeLessThanOrEqual(l.area.y + l.area.h);
    }
  });
});

describe("Passive Tree marks the route while following", () => {
  const index = tree();
  const plan = resolvePlan(GUIDE, index);
  const view = { panX: 400, panY: 300, zoom: 1 };
  const layout = (build, allocated = []) => layoutPassiveTree({
    index, view, allocatedNodeIds: allocated, startNodeId: 1, passivePoints: 3, gold: 0, build,
  });
  const markOf = (l, id) => l.nodes.find((n) => n.id === id).build;

  it("nothing is marked when not following, and there is still a switch to turn it on", () => {
    const l = layout({ guide: GUIDE, following: false, progress: null });
    expect(l.nodes.every((n) => n.build === null)).toBe(true);
    expect(l.buildBtn).toMatchObject({ following: false });
    expect(l.hitAreas.some((a) => a.kind === "passivebuild")).toBe(true);
    expect(l.buildCard).toBeNull();
  });

  it("no guide for the class: no switch, no marks, tree unchanged", () => {
    const l = layout(null);
    expect(l.buildBtn).toBeNull();
    expect(l.hitAreas.some((a) => a.kind === "passivebuild")).toBe(false);
    expect(l.nodes.every((n) => n.build === null)).toBe(true);
  });

  it("marks the next node, the few after it, and the rest of the route; leaves off-route nodes alone", () => {
    const progress = buildProgress(plan, index, [], 1);
    const l = layout({ guide: GUIDE, following: true, progress });
    expect(markOf(l, 2)).toBe("next");
    expect(markOf(l, 3)).toBe("soon");
    expect(markOf(l, 4)).toBe("soon");
    expect(markOf(l, 5)).toBeNull(); // not on the route
    expect(l.buildBtn.following).toBe(true);
    expect(l.buildCard.lines[0]).toBe("Build: Test Build");
    expect(l.buildCard.lines.some((t) => t.startsWith("Next: Node 2"))).toBe(true);
  });

  it("route edges ahead are flagged; edges between already-taken nodes are not", () => {
    const progress = buildProgress(plan, index, [2], 1);
    const l = layout({ guide: GUIDE, following: true, progress }, [2]);
    const edge = (a, b) => l.edges.find((e) => e.a === a && e.b === b);
    expect(edge(2, 3).build).toBe(true);
    expect(edge(3, 4).build).toBe(true);
    expect(edge(1, 2).build).toBe(false);
    expect(edge(4, 5).build).toBe(false);
  });

  it("a finished route says so and marks nothing", () => {
    const progress = buildProgress(plan, index, [2, 3, 4], 1);
    const l = layout({ guide: GUIDE, following: true, progress }, [2, 3, 4]);
    expect(l.nodes.every((n) => n.build === null)).toBe(true);
    expect(l.buildCard.lines).toContain("Route complete");
  });
});
