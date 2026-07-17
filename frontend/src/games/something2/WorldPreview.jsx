import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import styled from 'styled-components';
import { fetchWorldPreview } from './src/js/net/worldPreviewClient.js';
import { isoFit, draw } from './src/js/systems/mapPreviewRenderer.js';

const REVEAL_MS = 700;

const Wrap = styled.div`position: relative; width: 100%; height: 100%;`;
const Canvas = styled.canvas`width: 100%; height: 100%; display: block;`;
const Overlay = styled.div`
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  color: rgba(255,255,255,0.4); font-size: 14px; pointer-events: none;
`;

export default function WorldPreview({ worldId, tileColors }) {
  const canvasRef = useRef(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['worldPreview', worldId],
    enabled: !!worldId,
    queryFn: () => fetchWorldPreview(worldId),
  });

  const tiles = Array.isArray(data?.data) && data.data.length ? data.data : null;

  // Live inputs read by the loop without restarting it.
  const tilesRef = useRef(null);
  const colorsRef = useRef(null);
  useEffect(() => { tilesRef.current = tiles; colorsRef.current = tileColors; });

  // Reveal then static; restarts when the selected world changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    let raf = 0, start = null;

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
      if (!t) return;
      if (start == null) start = now;
      const rows = t.length, cols = t[0].length;
      const fit = isoFit(rows, cols, boxW, boxH, 12);
      const progress = Math.min(1, (now - start) / REVEAL_MS);
      draw(ctx, { tiles: t, tileColors: colorsRef.current, entities: null, fit, revealProgress: progress });
    };
    raf = requestAnimationFrame(frame);

    const onResize = () => sizeCanvas();
    window.addEventListener('resize', onResize);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', onResize); };
  }, [worldId]);

  return (
    <Wrap>
      <Canvas ref={canvasRef} />
      {(isLoading || isError || !tiles) && (
        <Overlay>{isError ? 'Preview unavailable' : (isLoading ? 'Loading preview…' : 'No preview')}</Overlay>
      )}
    </Wrap>
  );
}
