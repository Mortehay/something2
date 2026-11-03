// The Build Guide wired into Game: the follow switch, the window, its hotkey and
// Esc, exclusivity with the other windows, and the route progress read off the
// player's real progression + the (real) guide data.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Game, DEFAULT_KEYBINDS } from "../Game.js";
import { BUILD_GUIDES } from "../buildGuides.data.js";
import { buildTreeIndex } from "../../systems/passiveTreePanel.js";
import { movementKeys } from "../../entities/Player.js";

const realWindow = globalThis.window;
const realStorage = globalThis.localStorage;
let handlers;

function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

function makeGame({ className = "Warrior", characterId = 7 } = {}) {
  const g = new Game();
  g.canvas = {
    addEventListener: () => {}, removeEventListener: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
    width: 1280, height: 720,
  };
  g.state = "playing";
  g.chunked = true;
  g.className = className;
  g.characterId = characterId;
  g.loadQuests = () => Promise.resolve();
  g._refreshRespecQuote = () => Promise.resolve();
  g._ensurePassiveTree = vi.fn(); // no network in tests
  g.toasts = [];
  g._showToast = (m) => g.toasts.push(m);
  return g;
}

// A tree containing the Warrior's whole route as a chain hanging off its start node.
function warriorTree() {
  const guide = BUILD_GUIDES.Warrior;
  const ids = new Map();
  let next = 1000;
  const startKey = guide.passives.startKey;
  ids.set(startKey, next++);
  for (const s of guide.passives.steps) ids.set(s.key, next++);
  const nodes = [...ids.entries()].map(([key, id], i) => ({
    id, key, label: key, kind: key === startKey ? "start" : "minor", x: i * 30, y: 0, sector: "core",
    grants: [], start_class: key === startKey ? "Warrior" : null,
  }));
  const edges = [];
  const order = [startKey, ...guide.passives.steps.map((s) => s.key)];
  for (let i = 1; i < order.length; i++) edges.push([ids.get(order[i - 1]), ids.get(order[i])]);
  return { tree: { nodes, edges }, ids, order };
}

beforeEach(() => {
  handlers = {};
  globalThis.window = {
    addEventListener: (type, fn) => { handlers[type] = fn; },
    removeEventListener: () => {},
  };
  globalThis.localStorage = fakeStorage();
});
afterEach(() => {
  globalThis.window = realWindow;
  globalThis.localStorage = realStorage;
  vi.restoreAllMocks();
});

describe("Game: the guide for the character's class", () => {
  it("finds the guide for each of the six classes and not for an unknown one", () => {
    for (const c of ["Warrior", "Mage", "Monk", "Cultist", "Archer", "Druid"]) {
      expect(makeGame({ className: c }).getBuildGuide()?.className, c).toBe(c);
    }
    expect(makeGame({ className: "Bard" }).getBuildGuide()).toBeNull();
    expect(makeGame({ className: null }).getBuildGuide()).toBeNull();
  });

  it("has a default hotkey and it collides with no other binding", () => {
    expect(DEFAULT_KEYBINDS.buildGuide).toBe("u");
    const keys = Object.entries(DEFAULT_KEYBINDS).filter(([k]) => k !== "buildGuide").map(([, v]) => v);
    expect(keys).not.toContain("u");
  });
});

describe("Game: follow this build", () => {
  it("toggles, tells the player, starts loading the tree, and remembers it per character", () => {
    const g = makeGame();
    expect(g.buildFollowing).toBe(false);
    g.toggleBuildFollowing();
    expect(g.buildFollowing).toBe(true);
    expect(g._ensurePassiveTree).toHaveBeenCalled();
    expect(g.toasts.at(-1)).toContain("Following build: Steel Whirl");
    expect(globalThis.localStorage.getItem("something2_build_follow_7")).toBe("1");

    g.toggleBuildFollowing();
    expect(g.buildFollowing).toBe(false);
    expect(g.toasts.at(-1)).toBe("Build tracking off.");
    expect(globalThis.localStorage.getItem("something2_build_follow_7")).toBeNull();
  });

  it("an explicit value wins over toggling", () => {
    const g = makeGame();
    g.toggleBuildFollowing(true);
    g.toggleBuildFollowing(true);
    expect(g.buildFollowing).toBe(true);
    g.toggleBuildFollowing(false);
    expect(g.buildFollowing).toBe(false);
  });

  it("a class without a guide cannot be switched on", () => {
    const g = makeGame({ className: "Bard" });
    g.toggleBuildFollowing();
    expect(g.buildFollowing).toBe(false);
    expect(g.toasts.at(-1)).toContain("No suggested build");
  });
});

describe("Game: the window", () => {
  it("opens, resets its scroll, asks for the tree, and closes", () => {
    const g = makeGame();
    g.buildGuideScroll = 99;
    g.openBuildGuide();
    expect(g.buildGuideOpen).toBe(true);
    expect(g.buildGuideScroll).toBe(0);
    expect(g._ensurePassiveTree).toHaveBeenCalled();
    g.closeBuildGuide();
    expect(g.buildGuideOpen).toBe(false);
  });

  it("while it is open no other window can open over it", () => {
    const g = makeGame();
    g.openBuildGuide();
    g.openInventory();
    g.openQuestLog();
    g.openSkills();
    g.openPassiveTree();
    expect(g.inventoryOpen || g.questLogOpen || g.skillsOpen || g.passiveTreeOpen).toBeFalsy();
    expect(g.buildGuideOpen).toBe(true);
  });

  it("opens from inside the Passive Tree (its card advertises the hotkey) by swapping windows", () => {
    const g = makeGame();
    g.openPassiveTree();
    expect(g.passiveTreeOpen).toBe(true);
    g.openBuildGuide();
    expect(g.buildGuideOpen).toBe(true);
    expect(g.passiveTreeOpen).toBe(false);
  });

  it("is refused while a shop-like window is open", () => {
    const g = makeGame();
    g.openShop({ villageId: 1, catalog: [], buyback: [] });
    g.openBuildGuide();
    expect(g.buildGuideOpen).toBe(false);
  });

  it("stops movement while open, like every other window", () => {
    const keys = { w: true };
    expect(movementKeys({ keys, buildGuideOpen: false })).toBe(keys);
    expect(movementKeys({ keys, buildGuideOpen: true })).toEqual({});
  });

  it("'U' toggles it and Esc closes it", () => {
    const g = makeGame();
    g.setupInput();
    const key = (k) => handlers.keydown({ key: k, code: `Key${k.toUpperCase()}`, repeat: false, target: null, preventDefault() {}, stopPropagation() {} });
    key("u");
    expect(g.buildGuideOpen).toBe(true);
    key("u");
    expect(g.buildGuideOpen).toBe(false);
    key("u");
    expect(g.buildGuideOpen).toBe(true);
    handlers.keydown({ key: "Escape", code: "Escape", repeat: false, target: null, preventDefault() {}, stopPropagation() {} });
    expect(g.buildGuideOpen).toBe(false);
  });

  it("hotbar digits do not fire skills while the guide is open", () => {
    const g = makeGame();
    g.setupInput();
    const cast = vi.spyOn(g, "_activateHotbarSkill").mockImplementation(() => {});
    g.openBuildGuide();
    handlers.keydown({ key: "1", code: "Digit1", repeat: false, target: null, preventDefault() {}, stopPropagation() {} });
    expect(cast).not.toHaveBeenCalled();
  });
});

describe("Game: route progress from the real guide data and the player's progression", () => {
  function withTree(g, allocatedKeys = []) {
    const { tree, ids } = warriorTree();
    g.passiveTree = tree;
    g.passiveIndex = buildTreeIndex(tree);
    g.passiveStartClass = "Warrior";
    g.progression = { allocatedNodeIds: allocatedKeys.map((k) => ids.get(k)), passivePoints: 3 };
    return ids;
  }

  it("no tree loaded yet: no progress and the window says to open the tree", () => {
    const g = makeGame();
    expect(g._buildProgress()).toBeNull();
    expect(g._buildGuideState().treeLoaded).toBe(false);
  });

  it("a fresh Warrior: nothing taken, the first step of the real route is next", () => {
    const g = makeGame();
    const ids = withTree(g);
    const p = g._buildProgress();
    const guide = BUILD_GUIDES.Warrior;
    expect(p.total).toBe(150);
    expect(p.done).toBe(0);
    expect(p.nextId).toBe(ids.get(guide.passives.steps[0].key));
    expect(p.nextStep.key).toBe(guide.passives.steps[0].key);
  });

  it("advances as the player allocates nodes in route order", () => {
    const g = makeGame();
    const guide = BUILD_GUIDES.Warrior;
    const taken = guide.passives.steps.slice(0, 12).map((s) => s.key);
    const ids = withTree(g, taken);
    const p = g._buildProgress();
    expect(p.done).toBe(12);
    expect(p.nextId).toBe(ids.get(guide.passives.steps[12].key));
    expect(p.offPlan).toBe(0);
    expect(g._buildGuideState().allocatedCount).toBe(12);
  });

  it("the tree gets marks only while following", () => {
    const g = makeGame();
    withTree(g);
    expect(g._passiveBuildState()).toMatchObject({ following: false, progress: null });
    g.toggleBuildFollowing(true);
    const s = g._passiveBuildState();
    expect(s.following).toBe(true);
    expect(s.progress.nextId).not.toBeNull();
    expect(makeGame({ className: "Bard" })._passiveBuildState()).toBeNull();
  });

  it("reports which recommended skills are already learned", () => {
    const g = makeGame();
    const first = BUILD_GUIDES.Warrior.hotbar[0].skillId;
    g.unlockedSkills = new Set([first]);
    const hb = g._buildGuideState().hotbar;
    expect(hb[0].owned).toBe(true);
    expect(hb.slice(1).every((h) => !h.owned)).toBe(true);
  });

  it("the route is re-resolved when a new tree arrives", () => {
    const g = makeGame();
    withTree(g);
    const first = g._buildProgress();
    withTree(g, [BUILD_GUIDES.Warrior.passives.steps[0].key]);
    expect(g._buildProgress().done).toBe(1);
    expect(first.done).toBe(0);
  });
});

describe("Game: the switch is restored for the character on entry", () => {
  it("loadFollowing is applied per character id", async () => {
    globalThis.localStorage.setItem("something2_build_follow_7", "1");
    const g = makeGame({ characterId: 7 });
    const { loadFollowing } = await import("../buildGuide.js");
    expect(loadFollowing(7)).toBe(true);
    expect(loadFollowing(8)).toBe(false);
    expect(g.buildFollowing).toBe(false); // the field itself is set by initChunked from this
  });
});
