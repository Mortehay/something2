// frontend/src/games/something2/Minimap.jsx
import { useEffect, useRef, useState, useCallback } from 'react';
import styled from 'styled-components';
import { fetchWorldOverview, needsRefetch } from './src/js/net/worldOverviewClient.js';
import { drawMinimap } from './src/js/systems/minimapRenderer.js';
import { MAP_TILE_SIZE } from './src/js/core/constants.js';

const SIZE = 180;         // minimap box (css px)
const CELL_PX = 12;       // iso diamond width per coarse cell
const REFETCH_MARGIN = 40; // tiles from window edge that trigger a refetch
const FALLBACK_STEP = 4;  // projection step before the first overview lands

const LS_KEY = 'something2:minimapVisible';

// Draw one frame into `ctx` for a box of `box` css px at `cellW` diamond size.
// Returns true if it drew live content (a snapshot existed).
function renderFrame(ctx, dpr, box, cellW, { gameRef, overviewRef, tileColors }) {
  const snap = gameRef.current && gameRef.current.getMinimapSnapshot
    ? gameRef.current.getMinimapSnapshot() : null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, box, box);
  if (!snap) return false;
  const pCol = snap.player.x / MAP_TILE_SIZE;
  const pRow = snap.player.y / MAP_TILE_SIZE;
  let overview = overviewRef.current;
  if (overview && overview.world_id !== snap.worldId) overview = null;
  drawMinimap(ctx, {
    overview,
    tileColors,
    player: { col: pCol, row: pRow, dir: snap.player.dir },
    creatures: snap.creatures.map((c) => ({ col: c.x / MAP_TILE_SIZE, row: c.y / MAP_TILE_SIZE, color: c.color })),
    doorways: overview ? overview.doorways : [],
    villages: overview ? overview.villages : [],
    view: { centerCol: pCol, centerRow: pRow, step: overview ? overview.step : FALLBACK_STEP, cellW, boxW: box, boxH: box },
  });
  return true;
}

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
  const fetchingRef = useRef(false);
  const tileColorsRef = useRef(tileColors);
  useEffect(() => { tileColorsRef.current = tileColors; });

  const persistVisible = useCallback((v) => {
    setVisible(v);
    localStorage.setItem(LS_KEY, v ? '1' : '0');
  }, []);

  // M toggles the minimap. Ignore when a modifier is held (Shift+M is the dev
  // render-mode toggle) or focus is in a text field.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key.toLowerCase() !== 'm' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
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

  // rAF draw loop — runs whenever visible. Reads a fresh snapshot each frame and
  // lazily (re)fetches the overview window when the player nears its edge or the
  // world changes.
  useEffect(() => {
    if (!visible) return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    let raf = 0;

    const maybeFetch = (worldId, pCol, pRow) => {
      const cached = overviewRef.current;
      const stale = cached && cached.world_id !== worldId;
      if (fetchingRef.current) return;
      if (!stale && !needsRefetch(cached, pCol, pRow, REFETCH_MARGIN)) return;
      fetchingRef.current = true;
      fetchWorldOverview(worldId, Math.round(pCol), Math.round(pRow))
        .then((ov) => { overviewRef.current = ov; })
        .catch(() => { /* keep last window; retry on the next frame that still needs it */ })
        .finally(() => { fetchingRef.current = false; });
    };

    const frame = () => {
      raf = requestAnimationFrame(frame);
      const snap = gameRef.current && gameRef.current.getMinimapSnapshot
        ? gameRef.current.getMinimapSnapshot() : null;
      if (snap) {
        const pCol = snap.player.x / MAP_TILE_SIZE;
        const pRow = snap.player.y / MAP_TILE_SIZE;
        maybeFetch(snap.worldId, pCol, pRow);
      }
      renderFrame(ctx, dpr, SIZE, CELL_PX, { gameRef, overviewRef, tileColors: tileColorsRef.current });
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [visible, gameRef]);

  // Esc, while the modal is open, closes it instead of pausing the game.
  // Capture phase wins over Game's window keydown (bubble phase) handler.
  useEffect(() => {
    if (!expanded) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); setExpanded(false); }
    };
    window.addEventListener('keydown', onKey, true); // capture
    return () => window.removeEventListener('keydown', onKey, true);
  }, [expanded]);

  // Modal rAF draw loop — larger box, wider window via a bigger cellW. Reuses
  // the same overviewRef as the small minimap; no extra fetching.
  useEffect(() => {
    if (!expanded) return undefined;
    const canvas = modalCanvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const box = Math.min(640, Math.floor(Math.min(window.innerWidth, window.innerHeight) * 0.8));
    canvas.width = box * dpr; canvas.height = box * dpr;
    canvas.style.width = `${box}px`; canvas.style.height = `${box}px`;
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      renderFrame(ctx, dpr, box, CELL_PX * 1.6, { gameRef, overviewRef, tileColors: tileColorsRef.current });
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [expanded, gameRef]);

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
