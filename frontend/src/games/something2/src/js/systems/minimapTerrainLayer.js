// Iso diamond path primitive. It lives here rather than in minimapRenderer so
// the dependency runs one way only: the renderer composes this module, never
// the reverse.
export function diamond(ctx, x, y, hw, hh) {
  ctx.beginPath();
  ctx.moveTo(x, y - hh);
  ctx.lineTo(x + hw, y);
  ctx.lineTo(x, y + hh);
  ctx.lineTo(x - hw, y);
  ctx.closePath();
}

// SOMET-444. The minimap's terrain is the only part of the frame that scales
// with the box: `drawMinimap` used to walk all 64x64 coarse cells of the
// overview window and fill a diamond per cell, every frame, in both the docked
// map and the 640px expand modal. That work is identical from frame to frame --
// the overview only changes on a refetch -- and it cost the expand modal half
// its frame rate.
//
// It can be cached because `worldTileToView` is AFFINE in the player centre:
// moving the player only translates the whole terrain image. So the window is
// rendered once into an offscreen bitmap at a fixed reference origin, and each
// frame blits it at an offset. Markers (player, creatures, landmarks) keep
// drawing per frame, so nothing loses smoothness.

// Size and padding of the bitmap that holds one whole overview window at a
// given diamond width. Cell (c, r) lands at ((c-r)*hw + padX, (c+r)*hh + padY);
// the padding is what keeps the westmost and northmost diamonds inside it.
export function terrainLayerGeometry(overview, cellW) {
  const hw = cellW / 2;
  const hh = cellW / 4;
  const { cols, rows } = overview;
  const spanX = (cols - 1 + rows - 1) * hw;
  const spanY = (cols - 1 + rows - 1) * hh;
  return {
    hw,
    hh,
    padX: (rows - 1) * hw + hw, // westmost point is cell (0, rows-1)
    padY: hh,                   // northmost point is cell (0, 0)
    width: spanX + cellW,
    height: spanY + cellW / 2,
  };
}

// Where to blit the bitmap so that the player centre lands at the box centre.
// Derived from worldTileToView: screen x of cell (c,r) is
// ((c - dc0) - (r - dr0)) * hw + boxW/2, and its position in the bitmap is
// (c - r) * hw + padX, so the difference is a constant per frame.
export function terrainLayerOffset(overview, view, geom) {
  const dc0 = (view.centerCol - overview.originCol) / overview.step;
  const dr0 = (view.centerRow - overview.originRow) / overview.step;
  return {
    x: view.boxW / 2 - geom.padX - (dc0 - dr0) * geom.hw,
    y: view.boxH / 2 - geom.padY - (dc0 + dr0) * geom.hh,
  };
}

// The clipped source->destination rectangle pair for one frame's blit, in
// DEVICE pixels on the source side and css px on the destination side, or null
// when the window has scrolled entirely out of the box. Both sides are snapped
// to whole device pixels so the copy is 1:1.
export function terrainBlit(overview, view, layer) {
  const { geom, dpr } = layer;
  const off = terrainLayerOffset(overview, view, geom);
  const snap = (v) => Math.round(v * dpr) / dpr;
  const ox = snap(off.x);
  const oy = snap(off.y);
  const dx = Math.max(0, ox);
  const dy = Math.max(0, oy);
  const dw = Math.min(view.boxW, ox + geom.width) - dx;
  const dh = Math.min(view.boxH, oy + geom.height) - dy;
  if (dw <= 0 || dh <= 0) return null;
  return {
    sx: Math.round((dx - ox) * dpr),
    sy: Math.round((dy - oy) * dpr),
    sw: Math.round(dw * dpr),
    sh: Math.round(dh * dpr),
    dx, dy, dw, dh,
  };
}

// Fill every non-empty cell of the window into `ctx`, in bitmap coordinates.
// This is the loop that used to run 60 times a second; it now runs once per
// overview.
export function drawTerrainLayer(ctx, overview, tileColors, geom) {
  const { hw, hh, padX, padY } = geom;
  for (let r = 0; r < overview.rows; r++) {
    const row = overview.tiles[r];
    if (!row) continue;
    for (let c = 0; c < overview.cols; c++) {
      const name = row[c];
      if (!name) continue;
      ctx.fillStyle = (tileColors && tileColors[name]) || "#334155";
      diamond(ctx, (c - r) * hw + padX, (c + r) * hh + padY, hw, hh);
      ctx.fill();
    }
  }
}

// True when a cached layer can be reused as-is. Identity comparison on the
// overview is deliberate: `overviewRef.current` is replaced wholesale by every
// fetch, so a new window is always a new object, and a window that was not
// refetched is always the same one. Same for tileColors, which the dev
// render-mode toggle swaps out.
export function layerMatches(cached, overview, tileColors, cellW, dpr) {
  return !!cached
    && cached.overview === overview
    && cached.tileColors === tileColors
    && cached.cellW === cellW
    && cached.dpr === dpr;
}

// A one-entry cache. `createCanvas(w, h)` is injected so the module stays
// testable in the node vitest env, which has no DOM.
export function createTerrainLayerCache(createCanvas) {
  let cached = null;
  let builds = 0;
  return {
    // Returns { canvas, geom, dpr } to hand to drawMinimap, or null when there
    // is no overview to draw yet.
    get(overview, tileColors, cellW, dpr) {
      if (!overview) return null;
      if (layerMatches(cached, overview, tileColors, cellW, dpr)) return cached.layer;
      const geom = terrainLayerGeometry(overview, cellW);
      const canvas = createCanvas(Math.ceil(geom.width * dpr), Math.ceil(geom.height * dpr));
      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawTerrainLayer(ctx, overview, tileColors, geom);
      builds += 1;
      cached = { overview, tileColors, cellW, dpr, layer: { canvas, geom, dpr } };
      return cached.layer;
    },
    // Test-only: how many times the bitmap was actually rendered. A cache that
    // silently rebuilt every frame would still look correct on screen.
    get builds() { return builds; },
  };
}

export function domCanvasFactory(w, h) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return canvas;
}
