// frontend/src/games/something2/src/js/systems/minimapFrame.js
//
// The seam between the engine's minimap snapshot and the pure renderer: it
// reads one frame's worth of state off the Game instance, converts it into the
// argument shape drawMinimap expects, and draws. Both minimap surfaces -- the
// docked box and the click-to-expand modal -- draw through here, so the
// translation lives in exactly one place.
//
// SOMET-488. It sits in its own module rather than inside Minimap.jsx because
// this translation needs direct test coverage and a component file cannot
// export a non-component without breaking Fast Refresh. The coverage is not
// optional: drawMinimap draws with whatever coordinates it is handed and Canvas
// 2D quietly discards a non-finite one, so a wrong shape here costs a whole
// marker layer with no error raised and no renderer test disturbed -- which is
// precisely how the creature dots vanished for two days.

import { drawMinimap } from './minimapRenderer.js';
import { MAP_TILE_SIZE } from '../core/constants.js';

// Projection step until the first overview window lands.
const FALLBACK_STEP = 4;

// Draw one frame into `ctx` for a box of `box` css px at `cellW` diamond size.
// Returns true if it drew live content (a snapshot existed).
export function renderFrame(ctx, dpr, box, cellW, { gameRef, overviewRef, tileColors, layerCache }) {
  const snap = gameRef.current && gameRef.current.getMinimapSnapshot
    ? gameRef.current.getMinimapSnapshot() : null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, box, box);
  if (!snap || !snap.player || !Number.isFinite(snap.player.x) || !Number.isFinite(snap.player.y)) return false;
  const pCol = snap.player.x / MAP_TILE_SIZE;
  const pRow = snap.player.y / MAP_TILE_SIZE;
  let overview = overviewRef.current;
  if (overview && overview.world_id !== snap.worldId) overview = null;
  drawMinimap(ctx, {
    overview,
    // SOMET-444. The terrain arrives as a pre-rendered bitmap. `layerCache`
    // rebuilds it only when the overview window, the palette, the diamond size
    // or the device pixel ratio changes -- so the per-cell loop that used to
    // cost the expand modal half its frame rate now runs once per refetch.
    terrainLayer: layerCache.get(overview, tileColors, cellW, dpr),
    player: { col: pCol, row: pRow, dir: snap.player.dir },
    // World pixels -> global tiles. drawMinimap projects markers from tile
    // coordinates (`col`/`row`), and the snapshot reports creature positions in
    // world pixels, the same as the player above. Handing the records straight
    // over is how SOMET-488 lost every creature dot: the renderer read two
    // absent fields, the projection produced NaN and Canvas 2D discarded the
    // arcs without a word.
    creatures: (snap.creatures || []).map((c) => ({
      col: c.x / MAP_TILE_SIZE, row: c.y / MAP_TILE_SIZE, color: c.color,
    })),
    doorways: (overview ? overview.doorways : (snap.doorways || [])).map((d) => {
      const live = (snap.doorways || []).find((sd) => sd.edge === d.edge);
      return live ? { ...d, toName: live.toName || d.toName } : d;
    }),
    villages: overview ? overview.villages : [],
    // SOMET-298. From the join-frame snapshot, not the overview: a waypoint's
    // lit/unlit state is per character, and the overview is a shared cached
    // terrain window. `phase` is read HERE, in the component, because the
    // renderer must stay a pure function of its arguments.
    landmarks: snap.landmarks || [],
    phase: performance.now(),
    view: { centerCol: pCol, centerRow: pRow, step: overview ? overview.step : FALLBACK_STEP, cellW, boxW: box, boxH: box },
  });
  return true;
}
