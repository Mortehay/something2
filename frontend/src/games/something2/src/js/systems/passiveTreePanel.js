// Layout for the canvas passive-tree window. PURE: this module computes rects,
// circles and culling and never touches a canvas -- the same split
// inventoryPanel.js states in its own header, and the reason ~1800-node culling
// is a unit test here rather than a frame-rate observation in a browser.
// drawPassiveTree paints exactly what layoutPassiveTree returns and decides
// nothing itself.
//
// WHY A SPATIAL INDEX. The seeded tree is 1806 nodes and 2142 edges and will
// not survive a naive draw loop once the player zooms in: every frame would
// transform and stroke the whole graph to paint the twenty nodes actually on
// screen. Nodes are bucketed into fixed 200-unit world cells once, when the
// tree arrives, and each frame visits only the cells the viewport overlaps.
//
// WHY EDGES COME OFF THE ADJACENCY, NOT THE EDGE LIST. Scanning all 2142 edges
// per frame to find the handful with both endpoints on screen is O(E) whatever
// the zoom, which defeats the point of culling the nodes. Walking the visible
// nodes' adjacency instead is O(visible x degree) -- at full zoom that is tens
// of lookups, not thousands. `layout.stats` reports both counts so the saving
// is a number a test can assert rather than a claim.
import { GAME_WIDTH, GAME_HEIGHT } from "../core/constants.js";

export const PANEL_W = 1200;
export const PANEL_H = 680;
const TITLE_H = 30;
const PAD = 12;

// One cell is a little wider than the widest ring gap, so a viewport of any
// realistic size touches a handful of cells rather than one or one hundred.
export const GRID_CELL = 200;

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 2;
// The seeded tree spans roughly +/-840 units of radius; at 0.35 that is ~588px
// tall, which fits the 626px viewport, so an opening player sees all of it.
export const DEFAULT_ZOOM = 0.35;

export const NODE_R = { minor: 7, notable: 12, keystone: 18, start: 16 };

const STATE_FILL = {
  allocated: "#166534",
  allocatable: "#1e3a5f",
  locked: "rgba(30,30,45,0.9)",
};
const STATE_STROKE = {
  allocated: "#4ade80",
  allocatable: "#4a9eff",
  locked: "#3a3a4e",
};

export function buildTreeIndex(tree) {
  const nodes = (tree && tree.nodes) || [];
  const edges = (tree && tree.edges) || [];
  const cells = new Map();
  const byId = new Map();
  const adjacency = new Map();
  for (const n of nodes) {
    byId.set(n.id, n);
    const key = `${Math.floor(n.x / GRID_CELL)},${Math.floor(n.y / GRID_CELL)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(n);
    if (!adjacency.has(n.id)) adjacency.set(n.id, []);
  }
  // Undirected: passive_edges stores each edge once, with a_id < b_id.
  for (const [a, b] of edges) {
    if (!adjacency.has(a)) adjacency.set(a, []);
    if (!adjacency.has(b)) adjacency.set(b, []);
    adjacency.get(a).push(b);
    adjacency.get(b).push(a);
  }
  return { cells, byId, adjacency, edges };
}

export function worldToScreen(x, y, view) {
  return { sx: x * view.zoom + view.panX, sy: y * view.zoom + view.panY };
}

export function screenToWorld(sx, sy, view) {
  return { x: (sx - view.panX) / view.zoom, y: (sy - view.panY) / view.zoom };
}

export function clampZoom(z) {
  const n = Number(z);
  if (!Number.isFinite(n)) return DEFAULT_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, n));
}

// Keeps the world point currently under (sx, sy) under it after the zoom.
// Zooming about the panel centre instead makes a wheel gesture feel like the
// tree is sliding away from the cursor.
export function zoomAbout(view, sx, sy, nextZoom) {
  const zoom = clampZoom(nextZoom);
  const w = screenToWorld(sx, sy, view);
  return { zoom, panX: sx - w.x * zoom, panY: sy - w.y * zoom };
}

// The widest node radius, so a circle that overlaps the viewport is kept even
// when its centre is outside it. Culling on the centre alone pops keystones in
// and out at the edge while panning.
const MAX_NODE_R = Math.max(...Object.values(NODE_R));

// `stats`, when passed, records how much work the cull actually saved:
// cellsVisited / nodesConsidered against the count returned. That is the only
// performance number this feature can honestly report -- see the module header.
export function visibleNodeIds(index, view, viewport, stats = null) {
  const pad = MAX_NODE_R * view.zoom;
  const tl = screenToWorld(viewport.x - pad, viewport.y - pad, view);
  const br = screenToWorld(viewport.x + viewport.w + pad, viewport.y + viewport.h + pad, view);
  const out = [];
  const cx0 = Math.floor(tl.x / GRID_CELL);
  const cx1 = Math.floor(br.x / GRID_CELL);
  const cy0 = Math.floor(tl.y / GRID_CELL);
  const cy1 = Math.floor(br.y / GRID_CELL);
  for (let cx = cx0; cx <= cx1; cx += 1) {
    for (let cy = cy0; cy <= cy1; cy += 1) {
      if (stats) stats.cellsVisited += 1;
      const bucket = index.cells.get(`${cx},${cy}`);
      if (!bucket) continue;
      // The cell sweep is coarse; this is the exact test.
      for (const n of bucket) {
        if (stats) stats.nodesConsidered += 1;
        if (n.x >= tl.x && n.x <= br.x && n.y >= tl.y && n.y <= br.y) out.push(n.id);
      }
    }
  }
  return out;
}

// A node is allocatable iff it is adjacent to the start node or to something
// already allocated -- the client's copy of the server rule in
// backend/src/services/passiveRules.js. It AUTHORIZES nothing: it exists only
// so the panel does not offer a click the server would refuse.
export function allocatableSet(index, allocatedNodeIds, startNodeId) {
  const allocated = new Set(allocatedNodeIds || []);
  const out = new Set();
  // No start node means no class root (a legacy `Player`, the demoted
  // `Ranger`): the server's startNodeIdFor returns null for those and refuses
  // every allocate, so offering one here would only produce a 400.
  if (startNodeId == null) return out;
  const consider = (id) => {
    for (const n of index.adjacency.get(id) || []) {
      if (!allocated.has(n) && n !== startNodeId) out.add(n);
    }
  };
  consider(startNodeId);
  for (const id of allocated) consider(id);
  return out;
}

function grantLine(g) {
  const sign = g.value < 0 ? "" : "+";
  switch (g.type) {
    case "stat": return `${sign}${g.value} ${g.stat}`;
    case "resource": return `${sign}${g.value} max ${g.pool}`;
    case "damage": return `${sign}${g.value}% ${g.element} damage`;
    case "resist": return `${sign}${g.value}% ${g.element} resistance`;
    case "status": return `your hits ${g.status}`;
    case "rule": return `${g.rule} x${g.value}`;
    default: return String(g.type);
  }
}

// Contract §6.4. T15 deletes the character sheet's respec control, so the
// affordability gate lives here now.
//
// `respecCost` MUST be the server's number (GET /api/progression's respecCost,
// itself produced by passiveTreeStore.respecQuote). A client that recomputed
// `respec_base_gold x level` locally is the bug systems/characterTab.js's F2 rule
// records: raise the setting server-side and the button shows itself affordable
// while every click 402s. An absent cost is therefore "disabled", not "free".
//
// `Number(null)` is 0, not NaN, so the finiteness check below tests for
// null/undefined FIRST. Without that a not-yet-fetched cost reads as a cost of
// zero -- free -- which is the inverse of the intended failure mode and would
// enable the button on exactly the frame the client knows the least.
function knownNumber(v) {
  return v != null && v !== '' && Number.isFinite(Number(v));
}

export function respecDisabled({ gold, respecCost, busy = false, allocatedCount = 1 } = {}) {
  if (busy) return true;
  if (!knownNumber(respecCost)) return true;
  // An unknown WALLET is disabling for the same reason an unknown cost is:
  // NaN < 2000 is false, so a missing gold would silently read as affordable.
  if (!knownNumber(gold)) return true;
  if (Number(allocatedCount) <= 0) return true;
  return Number(gold) < Number(respecCost);
}

export function layoutPassiveTree(state) {
  const {
    index,
    allocatedNodeIds = [],
    startNodeId = null,
    passivePoints = 0,
    gold = 0,
    respecCost = null,
    respecBusy = false,
    view,
    hoverX = null,
    hoverY = null,
  } = state;

  const px = (GAME_WIDTH - PANEL_W) / 2;
  const py = (GAME_HEIGHT - PANEL_H) / 2;
  const panel = { x: px, y: py, w: PANEL_W, h: PANEL_H };
  const title = { x: px, y: py, w: PANEL_W, h: TITLE_H };
  const close = { x: px + PANEL_W - 8 - 20, y: py + 5, w: 20, h: 20 };
  const viewport = {
    x: px + PAD, y: py + TITLE_H + PAD,
    w: PANEL_W - PAD * 2, h: PANEL_H - TITLE_H - PAD * 2,
  };

  const hitAreas = [{ ...close, kind: "passiveclose", id: null }];

  const allocated = new Set(allocatedNodeIds);
  // A node the player cannot pay for is drawn LOCKED, not allocatable: an
  // affordance for a click that can only 400 is worse than no affordance.
  const allocatable = passivePoints > 0
    ? allocatableSet(index, allocatedNodeIds, startNodeId)
    : new Set();

  const stats = {
    totalNodes: index.byId.size,
    totalEdges: index.edges.length,
    cellsVisited: 0,
    nodesConsidered: 0,
    nodesDrawn: 0,
    edgesConsidered: 0,
    edgesDrawn: 0,
  };

  const visible = visibleNodeIds(index, view, viewport, stats);
  const visibleSet = new Set(visible);

  const nodes = [];
  for (const id of visible) {
    const n = index.byId.get(id);
    const { sx, sy } = worldToScreen(n.x, n.y, view);
    let nodeState = "locked";
    if (id === startNodeId || allocated.has(id)) nodeState = "allocated";
    else if (allocatable.has(id)) nodeState = "allocatable";
    const r = NODE_R[n.kind] * view.zoom;
    nodes.push({
      id, key: n.key, sx, sy, r, kind: n.kind, label: n.label,
      grants: n.grants || [], state: nodeState,
    });
    hitAreas.push({ x: sx - r, y: sy - r, w: r * 2, h: r * 2, kind: "passivenode", id });
  }
  stats.nodesDrawn = nodes.length;

  // Edges between VISIBLE nodes only, walked off the adjacency of what
  // survived culling rather than off the 2142-entry edge list. An edge with one
  // endpoint off-screen contributes at most a stub at the panel border and
  // costs a full transform plus a stroke.
  const edges = [];
  for (const a of visible) {
    for (const b of index.adjacency.get(a) || []) {
      stats.edgesConsidered += 1;
      // Each pair is reached from both ends; keep it once.
      if (b <= a || !visibleSet.has(b)) continue;
      const na = index.byId.get(a);
      const nb = index.byId.get(b);
      const pa = worldToScreen(na.x, na.y, view);
      const pb = worldToScreen(nb.x, nb.y, view);
      edges.push({
        x1: pa.sx, y1: pa.sy, x2: pb.sx, y2: pb.sy,
        lit: (allocated.has(a) || a === startNodeId) && (allocated.has(b) || b === startNodeId),
      });
    }
  }
  stats.edgesDrawn = edges.length;

  let hover = null;
  if (hoverX != null && hoverY != null) {
    const hit = nodes.find((n) => Math.hypot(hoverX - n.sx, hoverY - n.sy) <= n.r);
    if (hit) {
      hover = {
        id: hit.id, label: hit.label, kind: hit.kind,
        lines: hit.grants.map(grantLine),
        sx: hit.sx, sy: hit.sy,
      };
    }
  }

  // Respec button, on the panel chrome below the tree viewport. Its hit area is
  // published ONLY when it is enabled: a disabled control that still hit-tests
  // is a click that silently 402s.
  const disabled = respecDisabled({
    gold, respecCost, busy: respecBusy, allocatedCount: allocated.size,
  });
  const respec = {
    x: px + PANEL_W - 200, y: py + PANEL_H - 34, w: 160, h: 24,
    label: knownNumber(respecCost) ? `Respec — ${respecCost}g` : "Respec — …",
    disabled,
  };
  if (!disabled) {
    hitAreas.push({
      x: respec.x, y: respec.y, w: respec.w, h: respec.h, kind: "passiverespec", id: null,
    });
  }

  return {
    panel, title, close, viewport, nodes, edges, hover, respec, hitAreas, stats,
    header: {
      pointsLabel: `Passive points: ${passivePoints}`,
      countLabel: `${allocated.size} allocated`,
      zoomLabel: `zoom ${view.zoom.toFixed(2)}x`,
    },
  };
}

export function hitNodeAt(layout, x, y) {
  if (typeof x !== "number" || typeof y !== "number") return null;
  for (const n of layout.nodes) {
    // The circle, not the bounding box: at zoom 2 a keystone's box corner is
    // 13px outside the node the player is looking at.
    if (Math.hypot(x - n.sx, y - n.sy) <= n.r) return n;
  }
  return null;
}

export function drawPassiveTree(ctx, layout) {
  const { panel, title, close, viewport } = layout;

  ctx.save();
  ctx.textBaseline = "top";
  ctx.fillStyle = "rgba(12,12,20,0.96)";
  ctx.fillRect(panel.x, panel.y, panel.w, panel.h);
  ctx.strokeStyle = "#3a3a4e";
  ctx.lineWidth = 2;
  ctx.strokeRect(panel.x, panel.y, panel.w, panel.h);

  ctx.fillStyle = "rgba(30,30,45,0.95)";
  ctx.fillRect(title.x, title.y, title.w, title.h);
  ctx.fillStyle = "#e5e7eb";
  ctx.font = "14px monospace";
  ctx.fillText("Passive Tree", title.x + 12, title.y + 8);
  ctx.fillStyle = "#fde68a";
  ctx.fillText(layout.header.pointsLabel, title.x + 160, title.y + 8);
  ctx.fillStyle = "#9ca3af";
  ctx.fillText(layout.header.countLabel, title.x + 400, title.y + 8);
  ctx.fillText(layout.header.zoomLabel, title.x + 540, title.y + 8);
  ctx.fillStyle = "rgba(120,40,40,0.9)";
  ctx.fillRect(close.x, close.y, close.w, close.h);
  ctx.fillStyle = "#e5e7eb";
  ctx.fillText("X", close.x + 6, close.y + 3);

  // Everything below is clipped to the viewport: a node half outside it must
  // be cut off by the panel edge, not painted over the title bar.
  ctx.save();
  ctx.beginPath();
  ctx.rect(viewport.x, viewport.y, viewport.w, viewport.h);
  ctx.clip();

  ctx.lineWidth = 1;
  for (const e of layout.edges) {
    ctx.strokeStyle = e.lit ? "#4ade80" : "#2a2a3a";
    ctx.beginPath();
    ctx.moveTo(e.x1, e.y1);
    ctx.lineTo(e.x2, e.y2);
    ctx.stroke();
  }

  for (const n of layout.nodes) {
    ctx.beginPath();
    ctx.arc(n.sx, n.sy, Math.max(1, n.r), 0, Math.PI * 2);
    ctx.fillStyle = STATE_FILL[n.state];
    ctx.fill();
    ctx.lineWidth = n.kind === "minor" ? 1 : 2;
    ctx.strokeStyle = STATE_STROKE[n.state];
    ctx.stroke();
  }

  ctx.restore();

  // Respec button. Drawn outside the clip so it always sits on the panel
  // chrome rather than being cut off by the tree viewport.
  const rb = layout.respec;
  ctx.font = "12px monospace";
  ctx.fillStyle = rb.disabled ? "rgba(40,40,60,0.85)" : "rgba(120,40,40,0.85)";
  ctx.fillRect(rb.x, rb.y, rb.w, rb.h);
  ctx.lineWidth = 1;
  ctx.strokeStyle = rb.disabled ? "#3a3a4e" : "#ef4444";
  ctx.strokeRect(rb.x, rb.y, rb.w, rb.h);
  ctx.fillStyle = rb.disabled ? "#6b7280" : "#e5e7eb";
  ctx.fillText(rb.label, rb.x + 8, rb.y + 6);

  ctx.fillStyle = "#6b7280";
  ctx.fillText("drag to pan · wheel to zoom · click a lit node to allocate",
    panel.x + 14, panel.y + panel.h - 28);

  // Tooltip last and OUTSIDE the clip, so a node at the viewport edge still
  // gets a readable box.
  const h = layout.hover;
  if (h) {
    ctx.font = "12px monospace";
    const lines = [h.label, ...h.lines];
    const w = Math.max(...lines.map((t) => ctx.measureText(t).width)) + 16;
    const boxH = 8 + lines.length * 15;
    const tx = Math.min(h.sx + 14, GAME_WIDTH - w - 4);
    const ty = Math.min(h.sy + 14, GAME_HEIGHT - boxH - 4);
    ctx.fillStyle = "rgba(10,10,18,0.96)";
    ctx.fillRect(tx, ty, w, boxH);
    ctx.strokeStyle = h.kind === "keystone" ? "#fde68a" : "#4a9eff";
    ctx.lineWidth = 1;
    ctx.strokeRect(tx, ty, w, boxH);
    ctx.fillStyle = "#e5e7eb";
    ctx.fillText(lines[0], tx + 8, ty + 5);
    ctx.fillStyle = "#9ca3af";
    for (let i = 1; i < lines.length; i += 1) ctx.fillText(lines[i], tx + 8, ty + 5 + i * 15);
  }

  ctx.restore();
}
