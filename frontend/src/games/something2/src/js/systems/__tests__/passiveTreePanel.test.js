import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildTreeIndex, worldToScreen, screenToWorld, visibleNodeIds, allocatableSet,
  clampZoom, zoomAbout, layoutPassiveTree, hitNodeAt, respecDisabled,
  GRID_CELL, NODE_R, MIN_ZOOM, MAX_ZOOM, DEFAULT_ZOOM,
} from "../passiveTreePanel.js";
import { GAME_WIDTH, GAME_HEIGHT } from "../../core/constants.js";

// A miniature tree with the same shape as the real one: a start node, a
// neighbour, a node two edges out, and one far away in world space so culling
// has something real to exclude.
const NODES = [
  { id: 1, key: "start-strength", sector: "strength", ring: 0, x: 0, y: 0, kind: "start", label: "Warrior", grants: [], start_class: "Warrior" },
  { id: 2, key: "strength-r1-0-0", sector: "strength", ring: 1, x: 50, y: 0, kind: "minor", label: "Sinew", grants: [{ type: "stat", stat: "strength", value: 2 }] },
  { id: 3, key: "strength-r1-0-1", sector: "strength", ring: 1, x: 100, y: 0, kind: "notable", label: "Great Sinew", grants: [{ type: "stat", stat: "strength", value: 8 }] },
  { id: 4, key: "strength-r3-0-0", sector: "strength", ring: 3, x: 800, y: 800, kind: "keystone", label: "Unbreakable", grants: [{ type: "stat", stat: "strength", value: 30 }] },
];
const EDGES = [[1, 2], [2, 3], [3, 4]];
const TREE = { nodes: NODES, edges: EDGES };

const baseState = (over = {}) => ({
  tree: TREE,
  index: buildTreeIndex(TREE),
  allocatedNodeIds: [],
  startNodeId: 1,
  passivePoints: 5,
  view: { panX: 640, panY: 360, zoom: 1 },
  hoverX: null,
  hoverY: null,
  ...over,
});

describe("spatial index", () => {
  it("buckets nodes by a fixed world-space grid", () => {
    const index = buildTreeIndex(TREE);
    expect(GRID_CELL).toBe(200);
    // x=0..100 all land in cell (0,0); x=800,y=800 lands in cell (4,4).
    expect(index.cells.get("0,0").map((n) => n.id).sort()).toEqual([1, 2, 3]);
    expect(index.cells.get("4,4").map((n) => n.id)).toEqual([4]);
  });

  it("indexes nodes by id and builds an undirected adjacency", () => {
    const index = buildTreeIndex(TREE);
    expect(index.byId.get(3).label).toBe("Great Sinew");
    expect([...index.adjacency.get(2)].sort()).toEqual([1, 3]);
    expect([...index.adjacency.get(4)]).toEqual([3]);
  });

  it("survives an empty tree, because that is what an unfetched graph is", () => {
    const index = buildTreeIndex(null);
    expect(index.byId.size).toBe(0);
    expect(visibleNodeIds(index, { panX: 0, panY: 0, zoom: 1 }, { x: 0, y: 0, w: 100, h: 100 }))
      .toEqual([]);
  });
});

describe("world <-> screen", () => {
  it("round-trips a point through both transforms", () => {
    const view = { panX: 300, panY: 200, zoom: 0.5 };
    const s = worldToScreen(120, -80, view);
    expect(s).toEqual({ sx: 360, sy: 160 });
    expect(screenToWorld(360, 160, view)).toEqual({ x: 120, y: -80 });
  });

  it("clamps zoom to the declared range", () => {
    expect(MIN_ZOOM).toBe(0.2);
    expect(MAX_ZOOM).toBe(2.5);
    expect(DEFAULT_ZOOM).toBe(0.55);
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(0.05)).toBe(0.2);
    expect(clampZoom(5)).toBe(2.5);
    expect(clampZoom("not-a-number")).toBe(DEFAULT_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(DEFAULT_ZOOM);
  });

  it("zooms about the cursor, keeping the world point under it fixed", () => {
    const view = { panX: 640, panY: 360, zoom: 1 };
    const next = zoomAbout(view, 700, 400, 2);
    // The world point under (700, 400) was (60, 40); after the zoom it must
    // still be under (700, 400), so pan moves to 700 - 60*2 = 580.
    expect(next.zoom).toBe(2);
    expect(next.panX).toBe(580);
    expect(next.panY).toBe(320);
    expect(worldToScreen(60, 40, next)).toEqual({ sx: 700, sy: 400 });
  });
});

describe("viewport culling", () => {
  it("returns only the nodes whose screen position falls inside the viewport", () => {
    const index = buildTreeIndex(TREE);
    const view = { panX: 640, panY: 360, zoom: 1 };
    const viewport = { x: 40, y: 60, w: 1200, h: 600 };
    const ids = visibleNodeIds(index, view, viewport).sort();
    // (800,800) maps to (1440,1160) -- off the canvas entirely.
    expect(ids).toEqual([1, 2, 3]);
  });

  it("brings the far node in once the view pans to it", () => {
    const index = buildTreeIndex(TREE);
    const view = { panX: -160, panY: -440, zoom: 1 };
    const viewport = { x: 40, y: 60, w: 1200, h: 600 };
    expect(visibleNodeIds(index, view, viewport)).toContain(4);
  });

  it("includes a node whose centre is just outside but whose circle overlaps", () => {
    // Culling on the centre alone pops a keystone in and out at the edge of
    // the viewport, which reads as flicker while panning.
    const index = buildTreeIndex({ nodes: [{ ...NODES[3], x: 0, y: 0 }], edges: [] });
    const view = { panX: 30, panY: 360, zoom: 1 };
    const viewport = { x: 40, y: 60, w: 1200, h: 600 };
    expect(visibleNodeIds(index, view, viewport)).toEqual([4]);
  });

  it("draws nothing, and does not throw, when the view is panned to empty space", () => {
    // Acceptance criterion 4. An empty region is the common case in this tree:
    // the six sectors are wedges with 4 degrees of gap between them and a large
    // empty disc outside ring 3.
    const l = layoutPassiveTree(baseState({ view: { panX: -80000, panY: -80000, zoom: 1 } }));
    expect(l.nodes).toEqual([]);
    expect(l.edges).toEqual([]);
    expect(l.hover).toBe(null);
    expect(l.hitAreas.filter((a) => a.kind === "passivenode")).toEqual([]);
    // The cull must not have walked the tree to find that out.
    expect(l.stats.nodesConsidered).toBe(0);
  });
});

describe("the three visual states", () => {
  it("marks the start node allocated-and-free, its neighbour allocatable, the rest locked", () => {
    const l = layoutPassiveTree(baseState());
    const byId = Object.fromEntries(l.nodes.map((n) => [n.id, n]));
    expect(byId[1].state).toBe("allocated");   // granted, not bought
    expect(byId[2].state).toBe("allocatable");
    expect(byId[3].state).toBe("locked");
  });

  it("opens the next node once its neighbour is allocated", () => {
    const l = layoutPassiveTree(baseState({ allocatedNodeIds: [2] }));
    const byId = Object.fromEntries(l.nodes.map((n) => [n.id, n]));
    expect(byId[2].state).toBe("allocated");
    expect(byId[3].state).toBe("allocatable");
  });

  it("shows nothing as allocatable when the wallet is empty", () => {
    const l = layoutPassiveTree(baseState({ passivePoints: 0 }));
    const byId = Object.fromEntries(l.nodes.map((n) => [n.id, n]));
    // Still reachable, but not affordable -- and a node the player cannot buy
    // must not look like one they can.
    expect(byId[2].state).toBe("locked");
  });

  it("computes allocatability without a start node as nothing at all", () => {
    const index = buildTreeIndex(TREE);
    const set = allocatableSet(index, [], null);
    expect(set.size).toBe(0);
  });

  it("never offers the start node itself, which costs no point and cannot be bought", () => {
    const index = buildTreeIndex(TREE);
    expect(allocatableSet(index, [2], 1).has(1)).toBe(false);
  });
});

describe("layout", () => {
  it("centres the panel on the canvas and puts the close box in the title bar", () => {
    const l = layoutPassiveTree(baseState());
    expect(l.panel.x + l.panel.w).toBeLessThanOrEqual(GAME_WIDTH);
    expect(l.panel.y + l.panel.h).toBeLessThanOrEqual(GAME_HEIGHT);
    expect(l.close.y).toBeGreaterThanOrEqual(l.title.y);
    expect(l.close.y + l.close.h).toBeLessThanOrEqual(l.title.y + l.title.h);
    expect(l.hitAreas).toContainEqual({ ...l.close, kind: "passiveclose", id: null });
  });

  it("scales a node's radius with the zoom and by its kind", () => {
    expect(NODE_R).toEqual({ minor: 7, notable: 12, keystone: 18, start: 16 });
    const l = layoutPassiveTree(baseState({ view: { panX: 640, panY: 360, zoom: 2 } }));
    const start = l.nodes.find((n) => n.id === 1);
    const minor = l.nodes.find((n) => n.id === 2);
    expect(start.r).toBe(32);
    expect(minor.r).toBe(14);
  });

  it("draws an edge only when BOTH of its endpoints survived culling", () => {
    const l = layoutPassiveTree(baseState());
    // 1-2 and 2-3 are both fully visible; 3-4 has an off-screen endpoint.
    expect(l.edges).toHaveLength(2);
    for (const e of l.edges) {
      expect(Number.isFinite(e.x1) && Number.isFinite(e.y2)).toBe(true);
    }
  });

  it("lights only an edge whose BOTH ends are held", () => {
    const l = layoutPassiveTree(baseState({ allocatedNodeIds: [2] }));
    // 1(start)-2(allocated) is lit; 2-3 is not.
    expect(l.edges.map((e) => e.lit)).toEqual([true, false]);
  });

  it("publishes one hit area per visible node so a click can be resolved", () => {
    const l = layoutPassiveTree(baseState());
    const nodeAreas = l.hitAreas.filter((a) => a.kind === "passivenode");
    expect(nodeAreas.map((a) => a.id).sort()).toEqual([1, 2, 3]);
  });

  it("hit-tests a node by its circle, not by its bounding box", () => {
    const l = layoutPassiveTree(baseState());
    const n = l.nodes.find((x) => x.id === 2);
    expect(hitNodeAt(l, n.sx, n.sy).id).toBe(2);
    // The corner of the bounding box is outside the circle by 0.41r.
    expect(hitNodeAt(l, n.sx + n.r * 0.9, n.sy + n.r * 0.9)).toBe(null);
    expect(hitNodeAt(l, 5, 5)).toBe(null);
  });

  it("hands a locked node back with its state, so the click handler can refuse it", () => {
    // Acceptance criterion 3. hitNodeAt is deliberately state-blind -- the
    // refusal lives in one place (Game._handlePassiveClick) rather than being
    // split across a hit test that sometimes returns null.
    const l = layoutPassiveTree(baseState());
    const locked = l.nodes.find((n) => n.id === 3);
    expect(locked.state).toBe("locked");
    expect(hitNodeAt(l, locked.sx, locked.sy).state).toBe("locked");
  });

  it("surfaces the hovered node's label and its grants, one line each", () => {
    const l = layoutPassiveTree(baseState({ hoverX: 640, hoverY: 360 }));
    expect(l.hover.id).toBe(1);
    const l2 = layoutPassiveTree(baseState({ hoverX: 690, hoverY: 360 }));
    expect(l2.hover.id).toBe(2);
    expect(l2.hover.label).toBe("Sinew");
    expect(l2.hover.lines).toEqual(["+2 strength"]);
  });

  it("renders every grant kind as a readable line", () => {
    const nodes = [{
      id: 9, key: "k", sector: "strength", ring: 3, x: 0, y: 0, kind: "keystone",
      label: "Everything",
      grants: [
        { type: "stat", stat: "strength", value: 30 },
        { type: "resource", pool: "hp", value: 150 },
        { type: "damage", element: "fire", value: 12 },
        { type: "resist", element: "ice", value: -15 },
        { type: "status", status: "burn", value: 1 },
        { type: "rule", rule: "lifeCostMultiplier", value: 0.75 },
      ],
      start_class: null,
    }];
    const tree = { nodes, edges: [] };
    const l = layoutPassiveTree(baseState({
      tree, index: buildTreeIndex(tree), startNodeId: null,
      hoverX: 640, hoverY: 360,
    }));
    expect(l.hover.lines).toEqual([
      "+30 strength",
      "+150 max hp",
      "+12% fire damage",
      "-15% ice resistance",
      "your hits burn",
      "lifeCostMultiplier x0.75",
    ]);
  });

  it("reports the point wallet in the header", () => {
    const l = layoutPassiveTree(baseState({ passivePoints: 17 }));
    expect(l.header.pointsLabel).toBe("Passive points: 17");
    expect(layoutPassiveTree(baseState({ allocatedNodeIds: [2, 3] })).header.countLabel)
      .toBe("2 allocated");
  });
});

// Performance is COUNTED, not timed. rAF frame time is unmeasurable on the
// build host (idle throttling), and both getImageData-as-flush and an
// off-screen software canvas have previously produced confident wrong answers
// here. What is asserted below is the only honest claim available: with a
// full-size tree in view, the layout touches a small fraction of it.
describe("culling actually culls, at full-tree scale", () => {
  // 1806 nodes on a 43x42 lattice with 200-unit spacing, i.e. the same order of
  // magnitude and the same world extent as the seeded tree, plus an edge to the
  // right-hand neighbour of every node (3,569 edges -- more than the real
  // 2,142). Built here rather than loaded from the backend seed so this test
  // has no database and no cross-package import.
  const nodes = [];
  const edges = [];
  const COLS = 43;
  for (let i = 0; i < 1806; i += 1) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    nodes.push({
      id: i + 1, key: `n${i}`, sector: "strength", ring: 2,
      x: (col - COLS / 2) * 200, y: (row - 21) * 200,
      kind: i % 60 === 0 ? "keystone" : "minor", label: `N${i}`, grants: [],
    });
    if (col < COLS - 1 && i + 2 <= 1806) edges.push([i + 1, i + 2]);
    if (i + COLS + 1 <= 1806) edges.push([i + 1, i + COLS + 1]);
  }
  const big = { nodes, edges };
  const index = buildTreeIndex(big);

  it("is a tree of the size the seeder actually produces", () => {
    expect(index.byId.size).toBe(1806);
    expect(index.edges.length).toBeGreaterThan(2142);
  });

  it("considers a small fraction of the tree at the default zoom", () => {
    const l = layoutPassiveTree({
      index, view: { panX: GAME_WIDTH / 2, panY: GAME_HEIGHT / 2, zoom: DEFAULT_ZOOM },
      allocatedNodeIds: [], startNodeId: 1, passivePoints: 0,
    });
    // The hard number: a naive loop transforms 1806 nodes and 3,569 edges every
    // frame regardless of zoom. These are what the grid sweep actually visits.
    expect(l.stats.totalNodes).toBe(1806);
    expect(l.stats.nodesConsidered).toBeLessThan(500);
    expect(l.stats.edgesConsidered).toBeLessThan(l.stats.totalEdges);
    expect(l.stats.nodesDrawn).toBeGreaterThan(0);
  });

  it("collapses to a handful of nodes when zoomed all the way in", () => {
    const l = layoutPassiveTree({
      index, view: { panX: GAME_WIDTH / 2, panY: GAME_HEIGHT / 2, zoom: MAX_ZOOM },
      allocatedNodeIds: [], startNodeId: 1, passivePoints: 0,
    });
    // 1176x626 of viewport at 2x is 588x313 world units, i.e. ~3x2 nodes on a
    // 200-unit lattice. Anything close to 1806 here means culling is inert.
    expect(l.stats.nodesDrawn).toBeLessThan(30);
    expect(l.stats.nodesConsidered).toBeLessThan(60);
    expect(l.stats.cellsVisited).toBeLessThan(30);
  });

  it("costs nothing at all in a region with no nodes", () => {
    const l = layoutPassiveTree({
      index, view: { panX: -900000, panY: -900000, zoom: MAX_ZOOM },
      allocatedNodeIds: [], startNodeId: 1, passivePoints: 0,
    });
    expect(l.stats.nodesConsidered).toBe(0);
    expect(l.stats.edgesConsidered).toBe(0);
  });
});

describe("respec control (contract §6.4)", () => {
  it("is enabled only when gold covers the server's cost and nothing is in flight", () => {
    expect(respecDisabled({ gold: 2000, respecCost: 2000, busy: false })).toBe(false);
    expect(respecDisabled({ gold: 1999, respecCost: 2000, busy: false })).toBe(true);
    expect(respecDisabled({ gold: 9999, respecCost: 2000, busy: true })).toBe(true);
  });

  it("is disabled while the cost is unknown, rather than guessing it", () => {
    // The cost comes from GET /api/progression's respecCost. A client that
    // computed RESPEC_BASE * level locally is the exact bug CharacterSheet's
    // F2 header records: raise the base server-side and every click 402s.
    expect(respecDisabled({ gold: 9999, respecCost: null, busy: false })).toBe(true);
    expect(respecDisabled({ gold: 9999, respecCost: undefined, busy: false })).toBe(true);
    expect(respecDisabled({})).toBe(true);
  });

  it("is disabled when there is nothing allocated to reset", () => {
    expect(respecDisabled({ gold: 9999, respecCost: 100, busy: false, allocatedCount: 0 })).toBe(true);
    expect(respecDisabled({ gold: 9999, respecCost: 100, busy: false, allocatedCount: 1 })).toBe(false);
  });

  it("publishes a respec hit area and labels it with the real cost", () => {
    const l = layoutPassiveTree(baseState({
      allocatedNodeIds: [2], gold: 5000, respecCost: 2000, respecBusy: false,
    }));
    expect(l.respec.label).toBe("Respec — 2000g");
    expect(l.respec.disabled).toBe(false);
    expect(l.hitAreas).toContainEqual({
      x: l.respec.x, y: l.respec.y, w: l.respec.w, h: l.respec.h, kind: "passiverespec", id: null,
    });
  });

  it("publishes no respec hit area while the button is disabled", () => {
    // A disabled control that still hit-tests is a click that silently 402s.
    const l = layoutPassiveTree(baseState({ allocatedNodeIds: [2], gold: 10, respecCost: 2000 }));
    expect(l.respec.disabled).toBe(true);
    expect(l.hitAreas.filter((a) => a.kind === "passiverespec")).toEqual([]);
    // ...and while one is already in flight.
    const busy = layoutPassiveTree(baseState({
      allocatedNodeIds: [2], gold: 5000, respecCost: 2000, respecBusy: true,
    }));
    expect(busy.hitAreas.filter((a) => a.kind === "passiverespec")).toEqual([]);
  });
});

// SOURCE-LEVEL GUARDS. Every runtime test in this repo runs under vitest's node
// environment, so Game.js cannot be instantiated here (it reaches for a canvas,
// a websocket and a rAF loop). These read the source instead -- the same
// technique hotkeyRegistry.test.js uses, and for the same reason: the property
// being guarded is "which module is allowed to write this", which no unit of
// behaviour can express.
describe("the single-writer rule survives this feature", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const game = fs.readFileSync(path.resolve(here, "../../core/Game.js"), "utf8");
  const client = fs.readFileSync(
    path.resolve(here, "../../net/passiveTreeClient.js"), "utf8");

  it("leaves Game.progression with exactly the writers it had before", () => {
    // core/progressionExtras.js's F1 header documents a cross-channel race that was
    // fixed by DELETING the second writer. An allocate response applied
    // straight to Game.progression would bring it back, and it would look like
    // a level-up occasionally undoing itself rather than like this feature.
    //
    // The four are: the constructor's null, the per-join reset's null, the
    // `joined` frame, and the onProgression push. This feature adds none.
    const writes = game.match(/this\.progression\s*=/g) || [];
    expect(writes).toHaveLength(4);

    // SOMET-483 moved the handler's body into Game._applyProgressionFrame (it
    // latches the derived-stat seed and refetches the curve numbers on a level
    // change), so the one-line shape this used to pin no longer exists. What
    // is still pinned, and is the actual property: the socket handler does
    // nothing but delegate, and inside that method there is exactly ONE
    // assignment to this.progression whose right-hand side is the frame's row.
    expect(game).toMatch(/onProgression:\s*\(msg\)\s*=>\s*this\._applyProgressionFrame\(msg\),/);
    const start = game.indexOf("_applyProgressionFrame(msg) {");
    expect(start).toBeGreaterThan(-1);
    const method = game.slice(start, game.indexOf("_refreshProgressionBundle() {", start));
    expect(method.match(/this\.progression\s*=/g)).toHaveLength(1);
    expect(method).toMatch(/this\.progression\s*=\s*msg\.progression;/);
  });

  it("never assigns the allocate or respec response to progression", () => {
    // Both HTTP calls are fire-and-forget by construction: allocatePassive
    // resolves to `true`, respecPassives to `{gold}` only, so there is no
    // progression object in the client's hands to assign in the first place.
    expect(client).toMatch(/await parseOrThrow\(res\);\r?\n\s*return true;/);
    expect(client).toMatch(/return \{ gold: body\.gold \};/);
    expect(game).not.toMatch(/allocatePassive\([\s\S]{0,200}?this\.progression\s*=/);
    expect(game).not.toMatch(/respecPassives\(\)[\s\S]{0,400}?this\.progression\s*=/);
  });

  it("reads the allocated set and the wallet off progression, not off a copy", () => {
    // A cached this.allocatedNodeIds would be a second writer wearing a
    // different name. The render call must dereference the row every frame.
    expect(game).toMatch(/allocatedNodeIds:\s*\(this\.progression && this\.progression\.allocatedNodeIds\)/);
    expect(game).toMatch(/passivePoints:\s*\(this\.progression && this\.progression\.passivePoints\)/);
  });

  it("binds the tree to plain P and to KeyP for non-Latin layouts", () => {
    expect(game).toMatch(/KeyP:\s*'p'/);
    expect(game).toMatch(/isKey\('p'\)/);
  });

  it("posts the allocation to the contract's route", () => {
    expect(client).toMatch(/\/api\/progression\/passives\/\$\{encodeURIComponent\(nodeId\)\}/);
    expect(client).toMatch(/method:\s*'POST'/);
    expect(client).toMatch(/\/api\/passive-tree/);
  });

  it("refuses to allocate anything the layout did not mark allocatable", () => {
    // Acceptance criterion 3, at the one seam that decides it. Reading the
    // source rather than the behaviour because the handler needs a live
    // RenderSystem; the layout half of the same rule is asserted above.
    expect(game).toMatch(/if \(!node \|\| node\.state !== 'allocatable'\) return;/);
  });
});
