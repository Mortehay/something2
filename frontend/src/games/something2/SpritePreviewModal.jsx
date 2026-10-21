// Preview popup for one sprite subject: concept image (left) beside the
// generated sheet at x2 (right), every sheet row labelled from sheet.json.
// A GPU-box prop (Props v2) has no sheet: the right side is the generated
// (trimmed) cutout image, previewed with a CSS stand-in for the idle effect it will
// get in game on approve (prop_fx: none | sway | shine).
import { useState } from 'react';
import styled, { keyframes } from 'styled-components';
import { useQuery } from '@tanstack/react-query';
import { Modal, Muted } from './seedUi.jsx';
import { assetUrl, assetUrlVersioned } from './useTileSprites.js';
import { isBoxProp, propEffect, propFxLabel, rowLabels } from './spriteSelection.js';

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
  const sheetKey = subject.atlas_key || subject.image_key;
  const manifest = useSheetManifest(subject.manifest_key, true);
  const engine = manifest.data?.engine;
  const header = [subject.name, subject.box_job_id, engine].filter(Boolean).join(' · ');
  const labels = rowLabels(manifest.data);
  const version = subject.job_updated_at;
  return (
    <Modal $w="900px" onClose={onClose} label={`Sprite preview: ${subject.name}`}>
      <h3 style={{ margin: 0 }}>{header}</h3>
      <Cols>
        <Col>
          <strong>Used image</strong>
          {subject.concept_key ? (
            <>
              <Img src={assetUrlVersioned(subject.concept_key, version)} alt="Concept"
                onLoad={(e) => setSize(`${e.target.naturalWidth}×${e.target.naturalHeight}`)} />
              <Muted>{fileName(subject.concept_key)}{size && ` · ${size}`}</Muted>
            </>
          ) : <Muted>No concept image</Muted>}
        </Col>
        {isBoxProp(subject) ? <PropResult subject={subject} version={version} /> : (
        <Col>
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
