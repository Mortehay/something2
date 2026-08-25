// Layout for the canvas passive-tree window. PURE: this module computes rects,
// circles and culling and never touches a canvas -- the same split
// inventoryPanel.js states in its own header, and the reason ~1800-node culling
// is a unit test here rather than a frame-rate observation in a browser.
// drawPassiveTree paints exactly what layoutPassiveTree returns and decides
// nothing itself.
//
// WHY A SPATIAL INDEX. The seeded tree is 1806 nodes and 2382 edges and will
// not survive a naive draw loop once the player zooms in: every frame would
// transform and stroke the whole graph to paint the twenty nodes actually on
// screen. Nodes are bucketed into fixed 200-unit world cells once, when the
// tree arrives, and each frame visits only the cells the viewport overlaps.
import { GAME_WIDTH, GAME_HEIGHT } from "../core/constants.js";

export const PANEL_W = 1200;
export const PANEL_H = 680;
const TITLE_H = 30;
const PAD = 12;

export const GRID_CELL = 200;

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 2.5;
export const DEFAULT_ZOOM = 0.55;

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

export const SECTOR_HUES = {
  strength: "#ef4444",     // Warrior red
  dexterity: "#10b981",    // Archer green
  intelligence: "#3b82f6", // Mage blue
  wisdom: "#06b6d4",       // Monk cyan
  constitution: "#a855f7", // Cultist purple
  charisma: "#f59e0b",     // Druid amber
  core: "#64748b",         // Core slate
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

export function zoomAbout(view, sx, sy, nextZoom) {
  const zoom = clampZoom(nextZoom);
  const w = screenToWorld(sx, sy, view);
  return { zoom, panX: sx - w.x * zoom, panY: sy - w.y * zoom };
}

const MAX_NODE_R = Math.max(...Object.values(NODE_R));

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
      for (const n of bucket) {
        if (stats) stats.nodesConsidered += 1;
        if (n.x >= tl.x && n.x <= br.x && n.y >= tl.y && n.y <= br.y) out.push(n.id);
      }
    }
  }
  return out;
}

export function allocatableSet(index, allocatedNodeIds, startNodeId) {
  const allocated = new Set(allocatedNodeIds || []);
  const out = new Set();
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

export function findShortestPath(index, fromNodeIds, targetId) {
  if (!index || !fromNodeIds || targetId == null) return [];
  const fromSet = new Set(fromNodeIds);
  if (fromSet.has(targetId)) return [];

  const queue = [];
  const parent = new Map();
  const visited = new Set(fromSet);

  for (const start of fromSet) {
    for (const neighbor of index.adjacency.get(start) || []) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        parent.set(neighbor, null);
        queue.push(neighbor);
      }
    }
  }

  let found = false;
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === targetId) {
      found = true;
      break;
    }
    for (const neighbor of index.adjacency.get(cur) || []) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        parent.set(neighbor, cur);
        queue.push(neighbor);
      }
    }
  }

  if (!found) return [];

  const path = [];
  let curr = targetId;
  while (curr != null) {
    path.unshift(curr);
    curr = parent.get(curr);
  }
  return path;
}

export function nodeMatchesSearch(node, query) {
  if (!query || typeof query !== "string") return false;
  const q = query.trim().toLowerCase();
  if (!q) return false;

  if (node.label && node.label.toLowerCase().includes(q)) return true;
  if (node.kind && node.kind.toLowerCase().includes(q)) return true;
  if (node.sector && node.sector.toLowerCase().includes(q)) return true;

  if (Array.isArray(node.grants)) {
    for (const g of node.grants) {
      if (g.type && String(g.type).toLowerCase().includes(q)) return true;
      if (g.stat && String(g.stat).toLowerCase().includes(q)) return true;
      if (g.element && String(g.element).toLowerCase().includes(q)) return true;
      if (g.pool && String(g.pool).toLowerCase().includes(q)) return true;
      if (g.status && String(g.status).toLowerCase().includes(q)) return true;
      if (g.rule && String(g.rule).toLowerCase().includes(q)) return true;
      const line = grantLine(g).toLowerCase();
      if (line.includes(q)) return true;
    }
  }
  return false;
}

export function grantLine(g) {
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

function knownNumber(v) {
  return v != null && v !== '' && Number.isFinite(Number(v));
}

export function respecDisabled({ gold, respecCost, busy = false, allocatedCount = 1 } = {}) {
  if (busy) return true;
  if (!knownNumber(respecCost)) return true;
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
    searchText = "",
    searchFocused = false,
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

  // Search input and clear hit areas:
  const searchBox = { x: px + 660, y: py + 4, w: 200, h: 22 };
  const searchClear = { x: px + 840, y: py + 4, w: 20, h: 22 };
  hitAreas.push({ ...searchBox, kind: "passivesearch", id: null });
  if (searchText && searchText.trim()) {
    hitAreas.push({ ...searchClear, kind: "passivesearchclear", id: null });
  }

  const allocated = new Set(allocatedNodeIds);
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

  const hasSearch = Boolean(searchText && searchText.trim());
  let searchMatchesCount = 0;
  if (hasSearch) {
    for (const n of index.byId.values()) {
      if (nodeMatchesSearch(n, searchText)) searchMatchesCount += 1;
    }
  }

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
    const isSearchMatch = hasSearch ? nodeMatchesSearch(n, searchText) : false;

    nodes.push({
      id, key: n.key, sx, sy, r, kind: n.kind, label: n.label,
      sector: n.sector,
      grants: n.grants || [], state: nodeState,
      searchMatch: isSearchMatch,
    });
    hitAreas.push({ x: sx - r, y: sy - r, w: r * 2, h: r * 2, kind: "passivenode", id });
  }
  stats.nodesDrawn = nodes.length;

  const edges = [];
  for (const a of visible) {
    for (const b of index.adjacency.get(a) || []) {
      stats.edgesConsidered += 1;
      if (b <= a || !visibleSet.has(b)) continue;
      const na = index.byId.get(a);
      const nb = index.byId.get(b);
      const pa = worldToScreen(na.x, na.y, view);
      const pb = worldToScreen(nb.x, nb.y, view);
      edges.push({
        x1: pa.sx, y1: pa.sy, x2: pb.sx, y2: pb.sy,
        a, b,
        lit: (allocated.has(a) || a === startNodeId) && (allocated.has(b) || b === startNodeId),
      });
    }
  }
  stats.edgesDrawn = edges.length;

  let hover = null;
  if (hoverX != null && hoverY != null) {
    const hit = nodes.find((n) => Math.hypot(hoverX - n.sx, hoverY - n.sy) <= n.r);
    if (hit) {
      const fromSet = new Set([...allocatedNodeIds, startNodeId].filter((x) => x != null));
      let path = [];
      if (!fromSet.has(hit.id)) {
        path = findShortestPath(index, fromSet, hit.id);
      }
      hover = {
        id: hit.id, label: hit.label, kind: hit.kind,
        lines: hit.grants.map(grantLine),
        sx: hit.sx, sy: hit.sy,
        path,
        pathPointsCost: path.length,
      };
    }
  }

  // Path edges to highlight for hover preview:
  const hoverPathSet = new Set(hover && hover.path ? hover.path : []);
  if (hoverPathSet.size > 0) {
    const fromSet = new Set([...allocatedNodeIds, startNodeId].filter((x) => x != null));
    for (const e of edges) {
      if ((hoverPathSet.has(e.a) || fromSet.has(e.a)) && hoverPathSet.has(e.b)) {
        e.pathPreview = true;
      } else if (hoverPathSet.has(e.a) && (hoverPathSet.has(e.b) || fromSet.has(e.b))) {
        e.pathPreview = true;
      }
    }
  }

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
    panel, title, close, viewport, searchBox, searchClear,
    nodes, edges, hover, respec, hitAreas, stats,
    searchText, searchFocused, hasSearch, searchMatchesCount,
    hoverPathSet,
    header: {
      pointsLabel: `Passive points: ${passivePoints}`,
      countLabel: `${allocated.size} allocated`,
      zoomLabel: `zoom ${view.zoom.toFixed(2)}x`,
      searchPlaceholder: searchText || "Search (e.g. fire, life, crit)...",
      searchMatchLabel: hasSearch ? `Matches: ${searchMatchesCount}` : "",
    },
  };
}

export function hitNodeAt(layout, x, y) {
  if (typeof x !== "number" || typeof y !== "number") return null;
  for (const n of layout.nodes) {
    if (Math.hypot(x - n.sx, y - n.sy) <= n.r) return n;
  }
  return null;
}

export function drawPassiveTree(ctx, layout) {
  const { panel, title, close, viewport, searchBox, searchClear } = layout;
  const now = typeof performance !== "undefined" ? performance.now() : 0;

  ctx.save();
  ctx.textBaseline = "top";
  ctx.fillStyle = "rgba(10,8,6,0.98)";
  ctx.fillRect(panel.x, panel.y, panel.w, panel.h);
  ctx.strokeStyle = "#4a3c2c";
  ctx.lineWidth = 2;
  ctx.strokeRect(panel.x, panel.y, panel.w, panel.h);

  // Title bar:
  ctx.fillStyle = "rgba(20,16,12,0.96)";
  ctx.fillRect(title.x, title.y, title.w, title.h);
  ctx.fillStyle = "#e5e7eb";
  ctx.font = "bold 14px monospace";
  ctx.fillText("Passive Tree", title.x + 12, title.y + 8);

  ctx.fillStyle = "#fde68a";
  ctx.font = "14px monospace";
  ctx.fillText(layout.header.pointsLabel, title.x + 180, title.y + 8);
  ctx.fillStyle = "#9ca3af";
  ctx.fillText(layout.header.countLabel, title.x + 360, title.y + 8);
  ctx.fillText(layout.header.zoomLabel, title.x + 480, title.y + 8);

  // Search input box in header:
  if (searchBox) {
    ctx.fillStyle = layout.searchFocused ? "rgba(30,35,50,0.95)" : "rgba(15,18,25,0.85)";
    ctx.fillRect(searchBox.x, searchBox.y, searchBox.w, searchBox.h);
    ctx.strokeStyle = layout.searchFocused ? "#60a5fa" : "#3d3224";
    ctx.lineWidth = 1;
    ctx.strokeRect(searchBox.x, searchBox.y, searchBox.w, searchBox.h);

    ctx.font = "12px monospace";
    if (layout.searchText) {
      ctx.fillStyle = "#f8fafc";
      ctx.fillText(layout.searchText, searchBox.x + 6, searchBox.y + 5);
      if (layout.searchFocused && Math.floor(now / 500) % 2 === 0) {
        const textW = ctx.measureText(layout.searchText).width;
        ctx.fillStyle = "#60a5fa";
        ctx.fillRect(searchBox.x + 6 + textW, searchBox.y + 4, 2, 14);
      }
      ctx.fillStyle = "#f59e0b";
      ctx.fillText(layout.header.searchMatchLabel, searchBox.x + searchBox.w + 10, searchBox.y + 5);
    } else {
      ctx.fillStyle = "#64748b";
      ctx.fillText(layout.header.searchPlaceholder, searchBox.x + 6, searchBox.y + 5);
    }
  }

  // Close [X] button:
  ctx.fillStyle = "rgba(140,35,35,0.9)";
  ctx.fillRect(close.x, close.y, close.w, close.h);
  ctx.fillStyle = "#e5e7eb";
  ctx.font = "bold 13px monospace";
  ctx.fillText("✕", close.x + 5, close.y + 4);

  // Viewport clipping:
  ctx.save();
  ctx.beginPath();
  ctx.rect(viewport.x, viewport.y, viewport.w, viewport.h);
  ctx.clip();

  // Background celestial atmosphere:
  ctx.fillStyle = "rgba(8,7,6,1)";
  ctx.fillRect(viewport.x, viewport.y, viewport.w, viewport.h);

  // 1. Edges:
  for (const e of layout.edges) {
    if (e.pathPreview) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#38bdf8";
      ctx.beginPath();
      ctx.moveTo(e.x1, e.y1);
      ctx.lineTo(e.x2, e.y2);
      ctx.stroke();
    } else if (e.lit) {
      ctx.lineWidth = 2.8;
      ctx.strokeStyle = "#4ade80";
      ctx.beginPath();
      ctx.moveTo(e.x1, e.y1);
      ctx.lineTo(e.x2, e.y2);
      ctx.stroke();
    } else {
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = layout.hasSearch ? "#1f1b15" : "#382e21";
      ctx.beginPath();
      ctx.moveTo(e.x1, e.y1);
      ctx.lineTo(e.x2, e.y2);
      ctx.stroke();
    }
  }

  // 2. Nodes: Exactly 1 arc and 1 fill per node
  for (const n of layout.nodes) {
    const isSearchDimmed = layout.hasSearch && !n.searchMatch;

    ctx.save();
    if (isSearchDimmed) ctx.globalAlpha = 0.35;

    ctx.beginPath();
    ctx.arc(n.sx, n.sy, Math.max(1, n.r), 0, Math.PI * 2);
    ctx.fillStyle = STATE_FILL[n.state];
    ctx.fill();

    // Medallion rim stroke styling:
    if (n.kind === "keystone") {
      ctx.lineWidth = 3;
      ctx.strokeStyle = n.state === "allocated" ? "#4ade80" : "#fde047";
      ctx.stroke();
    } else if (n.kind === "notable") {
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = n.state === "allocated" ? "#4ade80" : "#f59e0b";
      ctx.stroke();
    } else if (n.kind === "start") {
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = "#60a5fa";
      ctx.stroke();
    } else {
      ctx.lineWidth = 1;
      if (n.state === "allocated") {
        ctx.strokeStyle = "#4ade80";
      } else if (n.state === "allocatable") {
        ctx.strokeStyle = "#60a5fa";
      } else {
        ctx.strokeStyle = SECTOR_HUES[n.sector] || STATE_STROKE[n.state];
      }
      ctx.stroke();
    }

    ctx.restore();
  }

  ctx.restore();

  // Respec button:
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
  ctx.fillText("drag to pan · wheel to zoom · click to allocate · right-click to refund 1 pt · Shift+click to auto-path",
    panel.x + 14, panel.y + panel.h - 28);

  // Tooltip with shortest path cost:
  const h = layout.hover;
  if (h) {
    ctx.font = "12px monospace";
    const lines = [h.label, ...h.lines];
    if (h.pathPointsCost > 0) {
      lines.push(`— Path: ${h.pathPointsCost} pt${h.pathPointsCost > 1 ? "s" : ""} (Shift+Click) —`);
    }
    const w = Math.max(...lines.map((t) => ctx.measureText(t).width)) + 16;
    const boxH = 8 + lines.length * 15;
    const tx = Math.min(h.sx + 14, GAME_WIDTH - w - 4);
    const ty = Math.min(h.sy + 14, GAME_HEIGHT - boxH - 4);
    ctx.fillStyle = "rgba(10,10,18,0.96)";
    ctx.fillRect(tx, ty, w, boxH);
    ctx.strokeStyle = h.kind === "keystone" ? "#fde68a" : h.kind === "notable" ? "#f59e0b" : "#4a9eff";
    ctx.lineWidth = 1;
    ctx.strokeRect(tx, ty, w, boxH);
    ctx.fillStyle = "#e5e7eb";
    ctx.fillText(lines[0], tx + 8, ty + 5);
    ctx.fillStyle = "#9ca3af";
    for (let i = 1; i < lines.length; i += 1) {
      if (i === lines.length - 1 && h.pathPointsCost > 0) {
        ctx.fillStyle = "#38bdf8";
      }
      ctx.fillText(lines[i], tx + 8, ty + 5 + i * 15);
    }
  }

  ctx.restore();
}
