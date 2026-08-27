// frontend/src/games/something2/Minimap.jsx
import { useEffect, useRef, useState, useCallback } from 'react';
import styled from 'styled-components';
import { createOverviewFetcher } from './src/js/net/worldOverviewClient.js';
import { renderFrame } from './src/js/systems/minimapFrame.js';
import { createTerrainLayerCache, domCanvasFactory } from './src/js/systems/minimapTerrainLayer.js';
import { createMinimapLoop } from './src/js/systems/minimapLoop.js';
import { MAP_TILE_SIZE } from './src/js/core/constants.js';

const SIZE = 180;         // minimap box (css px)
const CELL_PX = 12;       // iso diamond width per coarse cell
const REFETCH_MARGIN = 40; // tiles from window edge that trigger a refetch

// SOMET-361/444. The overview window and the creature snapshot behind the map
// only change at roughly 5Hz, so redrawing at the full animation frame rate was
// re-compositing an unchanged picture -- cheap for the 180px docked box, and
// half the frame rate for the 640px expand modal.
//
// 15Hz rather than the 5Hz data rate: the map is player-centred, so the terrain
// scrolls continuously under a walking player even when no new data has
// arrived, and at 5Hz that scroll visibly judders.
//
// This is a CAP, not an exact rate -- a draw happens on the first frame at or
// after the interval, so at 60fps the effective rate is 12-15Hz.
const MINIMAP_DRAW_HZ = 15;
const MINIMAP_DRAW_INTERVAL_MS = 1000 / MINIMAP_DRAW_HZ;

const LS_KEY = 'something2:minimapVisible';

const Frame = styled.div`
  position: absolute;
  top: 64px;   /* clears the 40px fullscreen toggle at top:16 + gap */
  right: 16px;
  z-index: 20;
  width: ${SIZE}px;
  height: ${SIZE}px;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid #2e2e3e;
  background: rgba(15, 15, 26, 0.75);
  backdrop-filter: blur(6px);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
  cursor: pointer;
  pointer-events: auto;
`;

const HideButton = styled.button`
  position: absolute;
  top: 4px;
  right: 4px;
  z-index: 21;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  border: 1px solid #2e2e3e;
  background: rgba(26, 26, 46, 0.85);
  color: #aaa;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  &:hover { color: #fff; }
`;

const ShowButton = styled.button`
  position: absolute;
  top: 64px;
  right: 16px;
  z-index: 20;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  border: 1px solid #2e2e3e;
  background: rgba(26, 26, 46, 0.8);
  backdrop-filter: blur(8px);
  color: #e6e6f0;
  cursor: pointer;
  pointer-events: auto;
  &:hover { color: #4a9eff; }
`;

const ExpandBackdrop = styled.div`
  position: absolute; inset: 0; z-index: 200;
  background: rgba(0,0,0,0.6);
  display: flex; align-items: center; justify-content: center;
  pointer-events: auto;
`;

const ExpandCard = styled.div`
  border-radius: 14px; overflow: hidden; border: 1px solid #2e2e3e;
  background: rgba(15,15,26,0.9); box-shadow: 0 12px 48px rgba(0,0,0,0.6);
`;

export default function Minimap({ gameRef, tileColors }) {
  const [visible, setVisible] = useState(() => localStorage.getItem(LS_KEY) !== '0');
  const [expanded, setExpanded] = useState(false);
  const canvasRef = useRef(null);
  const modalCanvasRef = useRef(null);
  const overviewRef = useRef(null);   // last fetched overview payload
  const tileColorsRef = useRef(tileColors);
  useEffect(() => { tileColorsRef.current = tileColors; });

  const persistVisible = useCallback((v) => {
    setVisible(v);
    if (!v) setExpanded(false); // hiding the minimap also closes the expand modal
    localStorage.setItem(LS_KEY, v ? '1' : '0');
  }, []);

  // M toggles the minimap. Ignore when a modifier is held (Shift+M is the dev
  // render-mode toggle) or focus is in a text field.
  useEffect(() => {
    const onKey = (e) => {
      const isM = (e.key || '').toLowerCase() === 'm' || e.code === 'KeyM';
      if (!isM || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      persistVisible(!visibleRef.current);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [persistVisible]);

  // Keep a ref of `visible` for the keydown closure above.
  const visibleRef = useRef(visible);
  useEffect(() => { visibleRef.current = visible; });

  // Keep a ref of `expanded` so the one draw loop can pick the modal canvas up
  // and drop it again WITHOUT being torn down and restarted. Restarting the
  // effect on expand/collapse is precisely what used to spawn the second loop.
  const expandedRef = useRef(expanded);
  useEffect(() => { expandedRef.current = expanded; });

  // The minimap's ONE animation loop. It runs whenever the minimap is visible
  // and draws into whichever canvases are mounted -- the docked box, plus the
  // expand modal while it is open.
  //
  // SOMET-361/444. Ticking and drawing are deliberately separated:
  //
  //   every frame        getMinimapSnapshot() runs. It is not just a read: it
  //                      updates Game._minimapDir, which the heading arrow
  //                      draws from, and it feeds the overview refetch edge
  //                      check that streams the map as the player walks.
  //                      Throttling it would stop the arrow tracking and stall
  //                      map streaming -- with every test still green.
  //
  //   <= MINIMAP_DRAW_HZ the canvases are redrawn.
  //
  // The data behind the map only changes at ~5Hz, so redrawing a 640px canvas
  // 60 times a second was re-compositing an unchanged picture -- which is where
  // the expanded map's frame time went (SOMET-444).
  useEffect(() => {
    if (!visible) return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;

    const dockedCache = createTerrainLayerCache(domCanvasFactory);
    // Set up lazily on the frame the modal's canvas first appears, and dropped
    // when it goes away -- which frees its ~1.2MB terrain bitmap. Its own cache
    // rather than the docked map's: the two draw at different cellW, so one
    // shared cache would rebuild the bitmap on alternating frames, strictly
    // worse than no cache at all.
    let modal = null; // { el, ctx, box, cache }

    // Backoff-guarded; see createOverviewFetcher for why a failure here must
    // not simply fall through to the next frame.
    const maybeFetch = createOverviewFetcher({ store: overviewRef, margin: REFETCH_MARGIN });

    const drawModal = () => {
      if (!modal) return;
      renderFrame(modal.ctx, dpr, modal.box, CELL_PX * 1.6, {
        gameRef, overviewRef, tileColors: tileColorsRef.current, layerCache: modal.cache,
      });
    };

    // Attach/detach the modal surface. Runs on every tick, not on the draw
    // cadence, so opening the map paints immediately instead of showing up to
    // one throttle interval of blank canvas.
    const syncModal = () => {
      const el = expandedRef.current ? modalCanvasRef.current : null;
      if (!el) { modal = null; return; }
      if (modal && modal.el === el) return;
      const box = Math.min(640, Math.floor(Math.min(window.innerWidth, window.innerHeight) * 0.8));
      el.width = box * dpr; el.height = box * dpr;
      el.style.width = `${box}px`; el.style.height = `${box}px`;
      modal = { el, ctx: el.getContext('2d'), box, cache: createTerrainLayerCache(domCanvasFactory) };
      drawModal();
    };

    const loop = createMinimapLoop({
      requestFrame: (cb) => window.requestAnimationFrame(cb),
      cancelFrame: (h) => window.cancelAnimationFrame(h),
      drawIntervalMs: MINIMAP_DRAW_INTERVAL_MS,
      onTick: (now) => {
        const snap = gameRef.current && gameRef.current.getMinimapSnapshot
          ? gameRef.current.getMinimapSnapshot() : null;
        if (snap) {
          maybeFetch(snap.worldId, snap.player.x / MAP_TILE_SIZE, snap.player.y / MAP_TILE_SIZE, now);
        }
        syncModal();
      },
      onDraw: () => {
        // The docked box keeps drawing while the modal is open: the backdrop
        // over it is only 60% opaque, so it stays faintly visible.
        renderFrame(ctx, dpr, SIZE, CELL_PX, {
          gameRef, overviewRef, tileColors: tileColorsRef.current, layerCache: dockedCache,
        });
        drawModal();
      },
    });
    loop.start();
    return () => { loop.stop(); modal = null; };
  }, [visible, gameRef]);

  // Esc, while the modal is open, closes it instead of pausing the game.
  // Capture phase wins over Game's window keydown (bubble phase) handler.
  // Guarded on `visible` too (belt-and-suspenders with persistVisible closing the
  // modal on hide): the modal can only be considered open while the minimap itself
  // is visible, so if `visible` ever goes false while `expanded` is still true this
  // listener must not remain attached.
  useEffect(() => {
    if (!expanded || !visible) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); setExpanded(false); }
    };
    window.addEventListener('keydown', onKey, true); // capture
    return () => window.removeEventListener('keydown', onKey, true);
  }, [expanded, visible]);

  if (!visible) {
    return <ShowButton type="button" title="Show minimap (M)" aria-label="Show minimap" onClick={() => persistVisible(true)}>🗺</ShowButton>;
  }
  return (
    <>
      <Frame title="Minimap — click to expand, M to hide" onClick={() => setExpanded(true)}>
        <canvas ref={canvasRef} style={{ width: `${SIZE}px`, height: `${SIZE}px`, display: 'block' }} />
        <HideButton type="button" title="Hide minimap (M)" aria-label="Hide minimap"
          onClick={(e) => { e.stopPropagation(); persistVisible(false); }}>×</HideButton>
      </Frame>
      {expanded && (
        <ExpandBackdrop onClick={() => setExpanded(false)}>
          <ExpandCard onClick={(e) => e.stopPropagation()}>
            <canvas ref={modalCanvasRef} style={{ display: 'block' }} />
          </ExpandCard>
        </ExpandBackdrop>
      )}
    </>
  );
}
