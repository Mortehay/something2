// Preview popup for one sprite subject: concept image (left) beside the
// generated sheet at x2 (right), every sheet row labelled from sheet.json.
// A GPU-box prop (Props v2) has no sheet: the right side is the generated
// (trimmed) cutout image, previewed with a CSS stand-in for the idle effect it will
// get in game on approve (prop_fx: none | sway | shine).
import { useEffect, useRef, useState } from 'react';
import styled, { keyframes } from 'styled-components';
import { useQuery } from '@tanstack/react-query';
import { Btn, Modal, Muted } from './seedUi.jsx';
import { assetUrl, assetUrlVersioned } from './useTileSprites.js';
import { conceptImageOf, conceptLabelOf, isBoxProp, sheetImageOf, sheetManifestOf, propEffect, propFxLabel, rowLabels } from './spriteSelection.js';
import SpriteFrameGrid from './SpriteFrameGrid.jsx';
import { changedUnmarked, compareMarkedFrames, initialMarksFor, redrawPayload, shouldConfirmClose } from './frameRedraw.js';
import { useActionCatalog, useDiscardRedraw, useRedrawFrames } from './useSpriteConsole.js';

const Cols = styled.div`display: flex; gap: 1.2rem; align-items: flex-start; flex-wrap: wrap; margin-top: 0.8rem;`;
const Col = styled.div`display: flex; flex-direction: column; gap: 0.4rem; min-width: 0;`;
// Checkerboard behind the art so an opaque backdrop is visible as one.
const CHECKER = 'conic-gradient(#b8b8b8 25%, #e6e6e6 0 50%, #b8b8b8 0 75%, #e6e6e6 0) 0 0 / 16px 16px';
const Img = styled.img`
  background: ${CHECKER};
  max-width: 100%; border: 1px solid var(--s2-border); border-radius: 4px;
  ${(p) => p.$pixel && 'image-rendering: pixelated;'}
`;
const Rows = styled.ul`margin: 0; padding-left: 1.2rem; list-style: none; font-size: 0.85rem; color: var(--s2-text-muted);`;
const Banner = styled.div`
  border: 1px solid var(--s2-danger); color: var(--s2-danger); border-radius: 6px; padding: 0.5rem 0.8rem;
  display: flex; gap: 0.8rem; align-items: center; flex-wrap: wrap; font-size: 1.2rem;
`;
const Links = styled.div`display: flex; gap: 1rem; font-size: 0.9rem;`;
// The CSS stand-in for the renderer's shear (systems/sway.js): about the base,
// 2.8 s period, ~±2° (atan 0.035).
const swayKeys = keyframes`
  0%, 100% { transform: skewX(-2deg); }
  50% { transform: skewX(2deg); }
`;
// The CSS stand-in for systems/shine.js: a diagonal glint crossing in 0.6 s
// of every 4.5 s (13.3%), masked by the image itself so it lights only the
// opaque pixels.
const shineKeys = keyframes`
  0% { background-position: 150% 0; }
  13.3%, 100% { background-position: -50% 0; }
`;
const FxFrame = styled.span`
  position: relative; display: inline-block; max-width: 100%; line-height: 0;
  & > img { transform-origin: bottom center; }
  &[data-fx='sway'] > img { animation: ${swayKeys} 2.8s ease-in-out infinite; }
  @media (prefers-reduced-motion: reduce) { &[data-fx='sway'] > img { animation: none; } }
`;
const Glint = styled.span`
  position: absolute; inset: 1px; pointer-events: none;
  background: linear-gradient(115deg, transparent 40%, rgba(255, 255, 240, 0.85) 50%, transparent 60%) 150% 0 / 300% 100% no-repeat;
  mix-blend-mode: screen;
  mask-size: 100% 100%; -webkit-mask-size: 100% 100%;
  animation: ${shineKeys} 4.5s linear infinite;
  @media (prefers-reduced-motion: reduce) { animation: none; opacity: 0; }
`;

// Decode a same-origin PNG into RGBA pixels (off-screen canvas).
function loadImageData(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const { data, width } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        resolve({ data, width });
      } catch (err) { reject(err); }
    };
    img.onerror = () => reject(new Error('image failed to load'));
    img.src = url;
  });
}

// Compare a done redraw's sheet with the sheet it started from; only runs once `enabled`.
function useCompare(enabled, previousUrl, nextUrl, manifest, redrawFrames) {
  const [state, setState] = useState({ status: 'idle', changed: [] });
  // Polled subjects hand back fresh arrays; depend on the content so the PNGs are not reloaded every poll.
  const framesKey = JSON.stringify(redrawFrames || []);
  useEffect(() => {
    if (!enabled || !previousUrl || !nextUrl || !manifest) return undefined;
    let live = true;
    setState({ status: 'loading', changed: [] });
    Promise.all([loadImageData(previousUrl), loadImageData(nextUrl)])
      .then(([prev, next]) => {
        if (live) setState({ status: 'ready', changed: changedUnmarked(prev, next, manifest, redrawFrames) });
      })
      .catch(() => { if (live) setState({ status: 'failed', changed: [] }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, previousUrl, nextUrl, manifest, framesKey]);
  return state;
}

function useSheetManifest(key, enabled) {
  return useQuery({
    queryKey: ['sprite-sheet-manifest', key],
    enabled: Boolean(enabled && key),
    queryFn: async () => {
      const res = await fetch(assetUrl(key));
      if (!res.ok) throw new Error(`sheet.json failed (${res.status})`);
      return res.json();
    },
  });
}

const fileName = (key) => String(key).split('/').pop();

function PropResult({ subject, version }) {
  const fx = propEffect(subject);
  const src = subject.image_key ? assetUrlVersioned(subject.image_key, version) : null;
  const mask = src ? `url(${JSON.stringify(src)})` : null;
  return (
    <Col>
      <strong>Generated (trimmed)</strong>
      {src ? (
        <FxFrame data-fx={fx}>
          <Img src={src} alt="Generated (trimmed)" />
          {fx === 'shine' && <Glint data-glint="on" style={{ maskImage: mask, WebkitMaskImage: mask }} />}
        </FxFrame>
      ) : <Muted>No result yet</Muted>}
      <Muted>{`Effect on approve: ${propFxLabel(fx)}`}</Muted>
      {subject.image_key && (
        <Links><a href={assetUrl(subject.image_key)} download>Download image PNG</a></Links>
      )}
    </Col>
  );
}

export default function SpritePreviewModal({ subject, onClose }) {
  const [size, setSize] = useState(null);
  const [sheetWidth, setSheetWidth] = useState(null);
  const sheetKey = sheetImageOf(subject);
  const manifestKey = sheetManifestOf(subject);
  const manifest = useSheetManifest(manifestKey, true);
  const [initialMarks] = useState(() => initialMarksFor(subject));
  const marksRef = useRef(initialMarks);
  // Mirrors the grid's marks so Retry (re)renders with what is marked now.
  const [marks, setMarks] = useState(initialMarks);
  const [sheetPx, setSheetPx] = useState(null);
  const [compareOn, setCompareOn] = useState(false);
  const redraw = useRedrawFrames();
  const discard = useDiscardRedraw();
  const { catalog } = useActionCatalog();
  const engine = manifest.data?.engine;
  const header = [subject.name, subject.box_job_id, engine].filter(Boolean).join(' · ');
  const labels = rowLabels(manifest.data);
  // A queued/failed redraw row has no sheet of its own: show the one it came from.
  const version = subject.atlas_key ? subject.job_updated_at : (subject.sheet_updated_at || subject.job_updated_at);
  const isRedraw = Boolean(subject.redraw_of);
  const failedRedraw = isRedraw && subject.job_state === 'failed';
  const gridState = ['done', 'approved'].includes(subject.job_state) || failedRedraw;
  const showGrid = subject.backend === 'gpu-box' && subject.generation_kind === 'creature'
    && Boolean(manifest.data) && Boolean(sheetKey) && gridState;
  const discardable = failedRedraw && (!subject.box_task_id || !subject.atlas_key);
  const canCompare = isRedraw && subject.job_state === 'done' && Boolean(subject.redraw_source_atlas_key);
  const previousUrl = canCompare ? assetUrl(subject.redraw_source_atlas_key) : null;
  const compareFrames = compareMarkedFrames(subject);
  const cmp = useCompare(compareOn && canCompare && showGrid, previousUrl, showGrid ? assetUrlVersioned(sheetKey, version) : null,
    manifest.data, compareFrames);
  const compareProps = compareOn && canCompare
    ? { previousUrl, redrawFrames: compareFrames, changedUnmarked: cmp.changed } : undefined;
  const retryFrames = failedRedraw ? redrawPayload(marks, manifest.data) : [];
  const boxStateUnknown = failedRedraw && Boolean(subject.box_task_id) && !subject.atlas_key;
  const firstRedrawnAction = canCompare ? (subject.redraw_frames || [])[0]?.action : undefined;
  const close = () => {
    const n = marksRef.current.size;
    if (shouldConfirmClose(marksRef.current, initialMarks) && !window.confirm(`Discard ${n} unsent frame marks?`)) return;
    onClose();
  };
  const sendFrames = (jobId) => (frames) => redraw.mutate({ jobId, frames }, { onSuccess: onClose });
  return (
    <Modal $w="900px" onClose={close} label={`Sprite preview: ${subject.name}`}>
      <h3 style={{ margin: 0 }}>{header}</h3>
      <Cols>
        <Col>
          <strong>{conceptLabelOf(subject)}</strong>
          {conceptImageOf(subject) ? (
            <>
              <Img src={assetUrlVersioned(conceptImageOf(subject), version)} alt="Concept"
                onLoad={(e) => setSize(`${e.target.naturalWidth}×${e.target.naturalHeight}`)} />
              <Muted>{fileName(conceptImageOf(subject))}{size && ` · ${size}`}</Muted>
            </>
          ) : <Muted>No concept image</Muted>}
        </Col>
        {isBoxProp(subject) ? <PropResult subject={subject} version={version} /> : showGrid ? (
        <Col>
          <strong>Frames (×2)</strong>
          {failedRedraw && (
            <Banner>
              <span>{`Redraw failed: ${subject.last_error || 'unknown error'}`}</span>
              {boxStateUnknown && <span>The GPU box state is unknown. Queue the whole sheet again to be safe.</span>}
              <Btn type="button" disabled={redraw.isPending || retryFrames.length === 0}
                onClick={() => sendFrames(subject.sheet_job_id)(retryFrames)}>Retry redraw</Btn>
              {discardable && (
                <Btn type="button" disabled={discard.isPending}
                  onClick={() => discard.mutate(subject.job_id, { onSuccess: onClose })}>Discard redraw</Btn>
              )}
            </Banner>
          )}
          <img src={assetUrlVersioned(sheetKey, version)} alt="" hidden
            onLoad={(e) => setSheetPx({ url: assetUrlVersioned(sheetKey, version), w: e.target.naturalWidth, h: e.target.naturalHeight })} />
          {canCompare && (
            <label style={{ fontSize: '1.2rem' }}>
              <input type="checkbox" checked={compareOn} onChange={(e) => setCompareOn(e.target.checked)} />
              {' Compare with previous'}
            </label>
          )}
          {compareOn && cmp.status === 'loading' && <Muted>Comparing sheets…</Muted>}
          {compareOn && cmp.status === 'failed' && <Muted>Could not compare the sheets, so no changed-frame warnings are shown.</Muted>}
          <SpriteFrameGrid sheetUrl={assetUrlVersioned(sheetKey, version)} manifest={manifest.data}
            sheetPx={sheetPx && sheetPx.url === assetUrlVersioned(sheetKey, version) ? { w: sheetPx.w, h: sheetPx.h } : null}
            initialMarks={initialMarks} initialAction={firstRedrawnAction} compare={compareProps}
            onMarksChange={(m) => { marksRef.current = m; setMarks(m); }}
            onSend={sendFrames(failedRedraw ? subject.sheet_job_id : subject.job_id)}
            secondsPerCell={catalog?.seconds_per_cell} sending={redraw.isPending} />
        </Col>
        ) : (
        <Col>
          {isRedraw && ['queued', 'running'].includes(subject.job_state) && (
            <Muted>{`Redraw ${subject.job_state}: showing the current sheet, read-only`}</Muted>
          )}
          <strong>Sheet (×2)</strong>
          {sheetKey ? (
            <Img $pixel src={assetUrlVersioned(sheetKey, version)} alt="Sprite sheet"
              style={{ width: sheetWidth ? `${sheetWidth * 2}px` : 'auto', maxWidth: 'none' }}
              onLoad={(e) => setSheetWidth(e.target.naturalWidth)} />
          ) : <Muted>No sheet</Muted>}
          {manifest.isLoading && subject.manifest_key && <Muted>Loading rows…</Muted>}
          {manifest.error && <Muted>{manifest.error.message}</Muted>}
          {labels.length > 0 && <Rows>{labels.map((l) => <li key={l}>{l}</li>)}</Rows>}
          <Links>
            {sheetKey && <a href={assetUrl(sheetKey)} download>Download sheet PNG</a>}
            {subject.manifest_key && <a href={assetUrl(subject.manifest_key)} download>Download sheet.json</a>}
          </Links>
        </Col>
        )}
      </Cols>
    </Modal>
  );
}
