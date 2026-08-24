import { describe, it, expect, vi, beforeEach } from "vitest";

// The whole point of this file is the two layers passiveTreePanel.test.js
// cannot reach: what actually gets PAINTED, and what a click actually SENDS.
// A layout module can be perfect and the feature still inert -- this epic has
// shipped that exact failure eight times (a burst with no reach drawing
// nothing; a player pacify with no wire path at all). So the network client is
// mocked here and the assertions are "the request went out", not "the function
// returned an object".
vi.mock("../../net/passiveTreeClient.js", () => ({
  fetchPassiveTree: vi.fn(async () => ({ nodes: [], edges: [], version: "0:0" })),
  allocatePassive: vi.fn(async () => true),
  respecPassives: vi.fn(async () => ({ gold: 3000 })),
  fetchRespecQuote: vi.fn(async () => ({ respecCost: 2000, gold: 5000, respecDisabled: false })),
  fetchStartClass: vi.fn(async () => "Warrior"),
}));

import {
  buildTreeIndex, layoutPassiveTree, drawPassiveTree,
} from "../passiveTreePanel.js";
import { RenderSystem } from "../RenderSystem.js";

const NativeMap = globalThis.Map;
import { Game } from "../../core/Game.js";
import {
  fetchPassiveTree, allocatePassive, respecPassives, fetchRespecQuote, fetchStartClass,
} from "../../net/passiveTreeClient.js";

// Recording 2D context, same convention as inventoryPanelDraw.test.js: the
// panel only ever writes to a context, so the geometry and the labels are what
// is asserted against.
function stubCtx() {
  const fillRects = [], texts = [], arcs = [], lines = [], fills = [], strokes = [];
  let fillStyle = null, strokeStyle = null;
  return {
    fillRects, texts, arcs, lines, fills, strokes,
    save() {}, restore() {}, clip() {}, rect() {},
    fillRect(x, y, w, h) { fillRects.push({ x, y, w, h, fillStyle }); },
    strokeRect() {},
    beginPath() { this._pending = null; },
    arc(x, y, r) { this._pending = { x, y, r }; arcs.push({ x, y, r }); },
    moveTo(x, y) { this._line = { x1: x, y1: y }; },
    lineTo(x, y) { this._line = { ...this._line, x2: x, y2: y }; },
    stroke() {
      strokes.push(strokeStyle);
      if (this._line && this._line.x2 !== undefined) { lines.push({ ...this._line, strokeStyle }); this._line = null; }
    },
    fill() { fills.push({ ...(this._pending || {}), fillStyle }); },
    fillText(text, x, y) { texts.push({ text: String(text), x, y }); },
    measureText(t) { return { width: String(t).length * 6 }; },
    set fillStyle(v) { fillStyle = v; }, get fillStyle() { return fillStyle; },
    set strokeStyle(v) { strokeStyle = v; }, get strokeStyle() { return strokeStyle; },
    set font(_v) {}, set lineWidth(_v) {}, set textAlign(_v) {}, set textBaseline(_v) {},
    set globalAlpha(_v) {},
  };
}

const NODES = [
  { id: 1, key: "start", sector: "strength", ring: 0, x: 0, y: 0, kind: "start", label: "Warrior", grants: [], start_class: "Warrior" },
  { id: 2, key: "a", sector: "strength", ring: 1, x: 50, y: 0, kind: "minor", label: "Sinew", grants: [{ type: "stat", stat: "strength", value: 2 }] },
  { id: 3, key: "b", sector: "strength", ring: 1, x: 100, y: 0, kind: "notable", label: "Great Sinew", grants: [{ type: "stat", stat: "strength", value: 8 }] },
];
const TREE = { nodes: NODES, edges: [[1, 2], [2, 3]] };

const state = (over = {}) => ({
  index: buildTreeIndex(TREE),
  allocatedNodeIds: [],
  startNodeId: 1,
  passivePoints: 5,
  gold: 5000,
  respecCost: null,
  view: { panX: 640, panY: 360, zoom: 1 },
  ...over,
});

describe("drawPassiveTree", () => {
  it("paints one circle per visible node and one line per visible edge", () => {
    const ctx = stubCtx();
    const layout = layoutPassiveTree(state());
    drawPassiveTree(ctx, layout);
    expect(ctx.arcs).toHaveLength(3);
    expect(ctx.arcs.map((a) => a.x).sort((p, q) => p - q)).toEqual([640, 690, 740]);
    expect(ctx.lines).toHaveLength(2);
  });

  it("gives the three states three different fills, so they are told apart", () => {
    const ctx = stubCtx();
    drawPassiveTree(ctx, layoutPassiveTree(state()));
    // Node fills only: the panel/title/close/respec rects go through fillRect.
    const nodeFills = ctx.fills.filter((f) => f.r !== undefined);
    const colours = nodeFills.map((f) => f.fillStyle);
    expect(new Set(colours).size).toBe(3);
    // ...and the allocated one is the green.
    expect(nodeFills.find((f) => f.x === 640).fillStyle).toBe("#166534");
  });

  it("lights only the edge whose both ends are held", () => {
    const ctx = stubCtx();
    drawPassiveTree(ctx, layoutPassiveTree(state({ allocatedNodeIds: [] })));
    const lit = ctx.lines.filter((l) => l.strokeStyle === "#4ade80");
    expect(lit).toHaveLength(0);

    const ctx2 = stubCtx();
    drawPassiveTree(ctx2, layoutPassiveTree(state({ allocatedNodeIds: [2] })));
    expect(ctx2.lines.filter((l) => l.strokeStyle === "#4ade80")).toHaveLength(1);
  });

  it("writes the wallet and the zoom into the title bar", () => {
    const ctx = stubCtx();
    drawPassiveTree(ctx, layoutPassiveTree(state({ passivePoints: 12 })));
    expect(ctx.texts.some((t) => t.text === "Passive points: 12")).toBe(true);
    expect(ctx.texts.some((t) => t.text === "zoom 1.00x")).toBe(true);
    expect(ctx.texts.some((t) => t.text === "Passive Tree")).toBe(true);
  });

  it("draws the tooltip only while a node is hovered, with every grant line", () => {
    const hot = stubCtx();
    drawPassiveTree(hot, layoutPassiveTree(state({ hoverX: 740, hoverY: 360 })));
    expect(hot.texts.some((t) => t.text === "Great Sinew")).toBe(true);
    expect(hot.texts.some((t) => t.text === "+8 strength")).toBe(true);

    const cold = stubCtx();
    drawPassiveTree(cold, layoutPassiveTree(state({ hoverX: 200, hoverY: 200 })));
    expect(cold.texts.some((t) => t.text === "Great Sinew")).toBe(false);
  });

  it("labels the respec button with the server's cost and greys it when unaffordable", () => {
    const rich = stubCtx();
    drawPassiveTree(rich, layoutPassiveTree(state({ allocatedNodeIds: [2], respecCost: 2000, gold: 5000 })));
    expect(rich.texts.some((t) => t.text === "Respec — 2000g")).toBe(true);

    const poor = stubCtx();
    const layout = layoutPassiveTree(state({ allocatedNodeIds: [2], respecCost: 2000, gold: 10 }));
    drawPassiveTree(poor, layout);
    const btn = poor.fillRects.find((r) => r.x === layout.respec.x && r.y === layout.respec.y);
    expect(btn.fillStyle).toBe("rgba(40,40,60,0.85)");
  });

  it("draws nothing but chrome when the view is over empty space", () => {
    // Acceptance criterion 4, at the draw layer: no arcs, no lines, no throw.
    const ctx = stubCtx();
    expect(() => drawPassiveTree(ctx, layoutPassiveTree(state({
      view: { panX: -90000, panY: -90000, zoom: 1 },
    })))).not.toThrow();
    expect(ctx.arcs).toEqual([]);
    expect(ctx.lines).toEqual([]);
    // Every coordinate that did reach the context is finite. Canvas 2D silently
    // DROPS a non-finite coordinate, so a NaN here deletes the whole layer with
    // every test still green (SOMET-488).
    for (const r of ctx.fillRects) {
      expect(Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.w)).toBe(true);
    }
  });
});

describe("RenderSystem delegation", () => {
  it("republishes the layout's hit areas so a click can still route", () => {
    const rs = Object.create(RenderSystem.prototype);
    const hits = [];
    const layout = rs.renderPassiveTree(stubCtx(), state({ allocatedNodeIds: [2], respecCost: 2000 }), hits);
    expect(hits.filter((a) => a.kind === "passivenode").map((a) => a.id).sort()).toEqual([1, 2, 3]);
    expect(hits.some((a) => a.kind === "passiveclose")).toBe(true);
    expect(hits.some((a) => a.kind === "passiverespec")).toBe(true);
    expect(layout.nodes).toHaveLength(3);
  });

  // The inert-feature guard, and the reason it drives the REAL renderChunked
  // rather than reading its source: a source match for the overlay block still
  // matches a block that has been disabled in front of the condition it names.
  // That was a live mutant this test let through in its grep form.
  function renderFrame(over = {}) {
    const rs = Object.create(RenderSystem.prototype);
    rs.ctx = stubCtx();
    rs.canvas = { width: 1280, height: 720 };
    rs.imageManager = { get: () => null };
    rs.renderHud = () => {};
    const seen = [];
    rs.renderPassiveTree = (ctx, s, hitAreas) => {
      seen.push(s);
      hitAreas.push({ kind: "passiveclose", id: null });
      return { marker: true };
    };
    rs.renderChunked({
      player: { x: 0, y: 0, width: 32, height: 32, hp: 10, maxHp: 10, facing: "down", effects: null },
      camera: { apply() {}, reset() {}, screenX: 0, screenY: 0, width: 1280, height: 720, x: 0, y: 0 },
      chunkedMap: { mapTiles: [], chunks: new NativeMap(), chunkSize: 16, tileSize: 32, loadedKeys: () => [] },
      remotePlayers: new NativeMap(),
      localUserId: 1,
      ...over,
    });
    return { rs, seen };
  }

  it("is actually reached from renderChunked when the panel is open", () => {
    const { rs, seen } = renderFrame({
      passiveTreeOpen: true,
      passiveIndex: buildTreeIndex(TREE),
      passiveView: { panX: 640, panY: 360, zoom: 1 },
      allocatedNodeIds: [2],
      passivePoints: 4,
      startNodeId: 1,
      gold: 5000,
      passiveRespecCost: 2000,
      passiveHoverX: 690,
      passiveHoverY: 360,
    });
    expect(seen).toHaveLength(1);
    expect(rs._passiveLayout).toEqual({ marker: true });
    expect(rs._passiveHitAreas.some((a) => a.kind === "passiveclose")).toBe(true);
    // Every field the panel needs actually arrives -- a default swallowed on
    // the way through renderChunked is the same inert failure one layer up.
    expect(seen[0]).toMatchObject({
      allocatedNodeIds: [2], passivePoints: 4, startNodeId: 1,
      gold: 5000, respecCost: 2000, hoverX: 690, hoverY: 360,
    });
  });

  it("is not reached, and publishes no stale rects, while the panel is closed", () => {
    const { rs, seen } = renderFrame({
      passiveTreeOpen: false,
      passiveIndex: buildTreeIndex(TREE),
      passiveView: { panX: 640, panY: 360, zoom: 1 },
    });
    expect(seen).toEqual([]);
    expect(rs._passiveLayout).toBe(null);
    expect(rs._passiveHitAreas).toEqual([]);
  });

  it("is not reached before the graph has arrived", () => {
    const { seen } = renderFrame({ passiveTreeOpen: true, passiveIndex: null, passiveView: null });
    expect(seen).toEqual([]);
  });
});

describe("Game routes a click in the tree to the server", () => {
  function makeGame() {
    globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
    const g = new Game();
    g.state = "playing";
    g.chunked = true;
    g.passiveTreeOpen = true;
    g.passiveTree = TREE;
    g.passiveIndex = buildTreeIndex(TREE);
    g.passiveStartClass = "Warrior";
    g.progression = { allocatedNodeIds: [], passivePoints: 5 };
    g.renderSystem = {
      _passiveLayout: layoutPassiveTree(state({ allocatedNodeIds: [2], respecCost: 2000, gold: 5000 })),
    };
    return g;
  }

  beforeEach(() => {
    allocatePassive.mockClear();
    respecPassives.mockClear();
    fetchPassiveTree.mockClear();
    fetchRespecQuote.mockClear();
    fetchStartClass.mockClear();
  });

  it("allocates the node under an allocatable circle", () => {
    const g = makeGame();
    // Node 3 is allocatable once 2 is held; it sits at screen (740, 360).
    g._handlePassiveClick(740, 360);
    expect(allocatePassive).toHaveBeenCalledWith(3);
  });

  it("refuses to allocate a locked node", () => {
    // Acceptance criterion 3, as behaviour rather than as a source match.
    const g = makeGame();
    g.renderSystem._passiveLayout = layoutPassiveTree(state({ allocatedNodeIds: [] }));
    // With nothing allocated, node 3 is two edges out and therefore locked.
    g._handlePassiveClick(740, 360);
    expect(allocatePassive).not.toHaveBeenCalled();
  });

  it("refuses the already-allocated start node", () => {
    const g = makeGame();
    g._handlePassiveClick(640, 360);
    expect(allocatePassive).not.toHaveBeenCalled();
  });

  it("sends nothing for a click on empty panel space", () => {
    const g = makeGame();
    g._handlePassiveClick(300, 600);
    expect(allocatePassive).not.toHaveBeenCalled();
  });

  it("never writes progression itself — that is the websocket frame's job", () => {
    const g = makeGame();
    const before = g.progression;
    g._handlePassiveClick(740, 360);
    expect(g.progression).toBe(before);
  });

  it("arms a pan for a press on empty space, and consumes a press on the [X]", () => {
    const g = makeGame();
    const close = g.renderSystem._passiveLayout.close;
    g._handlePassivePress(close.x + 2, close.y + 2);
    expect(g.passiveTreeOpen).toBe(false);
    expect(g.passiveDrag).toBe(null);

    const g2 = makeGame();
    g2._handlePassivePress(300, 600);
    expect(g2.passiveDrag).toEqual({ startX: 300, startY: 600, lastX: 300, lastY: 600, moved: false });
  });

  it("fires the respec only from the enabled button's hit area", () => {
    const g = makeGame();
    const rb = g.renderSystem._passiveLayout.respec;
    expect(rb.disabled).toBe(false);
    g._handlePassivePress(rb.x + 2, rb.y + 2);
    expect(respecPassives).toHaveBeenCalledTimes(1);
    expect(g.passiveRespecBusy).toBe(true);
  });

  it("does not fire the respec when the button is disabled, and pans instead", () => {
    const g = makeGame();
    const layout = layoutPassiveTree(state({ allocatedNodeIds: [2], respecCost: 2000, gold: 10 }));
    g.renderSystem._passiveLayout = layout;
    g._handlePassivePress(layout.respec.x + 2, layout.respec.y + 2);
    expect(respecPassives).not.toHaveBeenCalled();
    expect(g.passiveDrag).not.toBe(null);
  });

  it("opens by fetching the graph once and the quote every time", async () => {
    const g = makeGame();
    g.passiveTree = null;
    g.passiveStartClass = null;
    g.passiveTreeOpen = false;
    g.openPassiveTree();
    await Promise.resolve();
    await Promise.resolve();
    expect(g.passiveTreeOpen).toBe(true);
    expect(fetchPassiveTree).toHaveBeenCalledTimes(1);
    expect(fetchStartClass).toHaveBeenCalledTimes(1);
    expect(fetchRespecQuote).toHaveBeenCalledTimes(1);

    g.openPassiveTree();
    expect(fetchPassiveTree).toHaveBeenCalledTimes(1);   // graph cached
    expect(fetchRespecQuote).toHaveBeenCalledTimes(2);   // cost is per-level
  });

  // The P KEY, driven through the real keydown handler rather than matched in
  // the source. A source assertion for isKey('p') still matches a branch that
  // has been disabled in front of it -- a live mutant this file let through in
  // its grep form.
  function gameWithInput() {
    const listeners = {};
    globalThis.window = {
      addEventListener: (t, fn) => { listeners[t] = fn; },
      removeEventListener: () => {},
    };
    const g = new Game();
    g.canvas = { addEventListener: () => {}, removeEventListener: () => {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
      width: 1280, height: 720 };
    g.setupInput();
    g.state = "playing";
    g.chunked = true;
    return { g, key: (k, over = {}) => listeners.keydown({ key: k, code: `Key${k.toUpperCase()}`, repeat: false, ...over }) };
  }

  it("opens and closes the tree on plain P", () => {
    const { g, key } = gameWithInput();
    key("p");
    expect(g.passiveTreeOpen).toBe(true);
    key("p");
    expect(g.passiveTreeOpen).toBe(false);
  });

  it("opens on KeyP even when e.key is not a Latin letter", () => {
    const { g, key } = gameWithInput();
    key("з", { code: "KeyP" });   // Cyrillic layout: same physical key
    expect(g.passiveTreeOpen).toBe(true);
  });

  it("closes on Escape, and lets Escape close the shop first", () => {
    const { g, key } = gameWithInput();
    key("p");
    key("Escape", { code: "Escape" });
    expect(g.passiveTreeOpen).toBe(false);
  });

  it("never stacks with the inventory in either order", () => {
    const { g, key } = gameWithInput();
    key("p");
    key("i");
    expect(g.inventoryOpen).toBe(false);
    key("p");                       // close the tree
    key("i");
    expect(g.inventoryOpen).toBe(true);
    key("p");
    expect(g.passiveTreeOpen).toBe(false);
  });

  it("resolves the start node from the class, and nothing without one", () => {
    const g = makeGame();
    expect(g._passiveStartNodeId()).toBe(1);
    g.passiveStartClass = "Ranger";      // demoted, has no start node
    expect(g._passiveStartNodeId()).toBe(null);
    g.passiveStartClass = null;
    expect(g._passiveStartNodeId()).toBe(null);
  });
});
