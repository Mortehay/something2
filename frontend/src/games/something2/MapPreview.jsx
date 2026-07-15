import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import styled from 'styled-components';
import { fetchMap, fetchMapEntities } from './useMaps.js';
import { isoFit, draw } from './src/js/systems/mapPreviewRenderer.js';

const REVEAL_MS = 700;

const Wrap = styled.div`
  position: relative;
  width: 100%;
  height: 100%;
`;

const Canvas = styled.canvas`
  width: 100%;
  height: 100%;
  display: block;
`;

const Overlay = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(255, 255, 255, 0.4);
  font-size: 14px;
  pointer-events: none;
`;

function parseTiles(mapData) {
  const d = mapData?.data;
  if (!d) return null;
  const tiles = typeof d === 'string' ? JSON.parse(d) : d;
  return Array.isArray(tiles) && tiles.length ? tiles : null;
}

export default function MapPreview({ mapId, tileColors }) {
  const canvasRef = useRef(null);

  const { data: mapData, isLoading, isError } = useQuery({
    queryKey: ['map', mapId], enabled: !!mapId, queryFn: () => fetchMap(mapId),
  });
  const { data: entities } = useQuery({
    queryKey: ['mapEntities', mapId], enabled: !!mapId, queryFn: () => fetchMapEntities(mapId),
  });

  const tiles = parseTiles(mapData);

  // Live inputs read by the animation loop without restarting it. Synced in an
  // effect (not during render) so the loop always sees the latest values.
  const tilesRef = useRef(null);
  const entitiesRef = useRef(null);
  const colorsRef = useRef(null);
  useEffect(() => {
    tilesRef.current = tiles;
    entitiesRef.current = entities;
    colorsRef.current = tileColors;
  });

  // Animation loop; reveal restarts only when the selected world changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    let raf = 0;
    let start = null;      // reveal start time (set once tiles exist)
    let baked = null;      // offscreen canvas of the fully-revealed map
    let bakedFor = null;   // { entities, w, h } the bake was made for

    const sizeCanvas = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    };
    sizeCanvas();

    const frame = (now) => {
      raf = requestAnimationFrame(frame);
      const t = tilesRef.current;
      const cw = canvas.width, ch = canvas.height;
      const boxW = cw / dpr, boxH = ch / dpr;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, boxW, boxH);
      if (!t) return; // nothing loaded yet -> overlay shows

      if (start == null) start = now;
      const rows = t.length, cols = t[0].length;
      const fit = isoFit(rows, cols, boxW, boxH, 12);
      const progress = Math.min(1, (now - start) / REVEAL_MS);

      if (progress < 1) {
        draw(ctx, { tiles: t, tileColors: colorsRef.current, entities: entitiesRef.current, fit, revealProgress: progress });
        baked = null; // force a fresh bake after the reveal completes
        return;
      }

      // Bake the revealed map once (re-bake if entities or size changed).
      if (!baked || !bakedFor || bakedFor.entities !== entitiesRef.current || bakedFor.w !== cw || bakedFor.h !== ch) {
        const off = document.createElement('canvas');
        off.width = cw; off.height = ch;
        const octx = off.getContext('2d');
        octx.setTransform(dpr, 0, 0, dpr, 0, 0);
        draw(octx, { tiles: t, tileColors: colorsRef.current, entities: entitiesRef.current, fit, revealProgress: 1 });
        baked = off;
        bakedFor = { entities: entitiesRef.current, w: cw, h: ch };
      }

      // Gentle idle drift: blit the baked map with a slow sinusoidal pan.
      const s = now / 1000;
      const amp = Math.min(boxW, boxH) * 0.02;
      const panX = Math.cos(s * 0.25) * amp;
      const panY = Math.sin(s * 0.2) * amp * 0.5;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      ctx.drawImage(baked, panX * dpr, panY * dpr);
    };
    raf = requestAnimationFrame(frame);

    const onResize = () => { sizeCanvas(); baked = null; };
    window.addEventListener('resize', onResize);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', onResize); };
  }, [mapId]);

  return (
    <Wrap>
      <Canvas ref={canvasRef} />
      {(isLoading || isError || !tiles) && (
        <Overlay>{isError ? 'Preview unavailable' : (isLoading ? 'Loading preview…' : 'No preview')}</Overlay>
      )}
    </Wrap>
  );
}
