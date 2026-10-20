// Preview popup for one sprite subject: concept image (left) beside the
// generated sheet at x2 (right), every sheet row labelled from sheet.json.
import { useState } from 'react';
import styled from 'styled-components';
import { useQuery } from '@tanstack/react-query';
import { Modal, Muted } from './seedUi.jsx';
import { assetUrl, assetUrlVersioned } from './useTileSprites.js';
import { rowLabels } from './spriteSelection.js';

const Cols = styled.div`display: flex; gap: 1.2rem; align-items: flex-start; flex-wrap: wrap; margin-top: 0.8rem;`;
const Col = styled.div`display: flex; flex-direction: column; gap: 0.4rem; min-width: 0;`;
const Img = styled.img`
  max-width: 100%; background: var(--s2-bg-sunken); border: 1px solid var(--s2-border); border-radius: 4px;
  ${(p) => p.$pixel && 'image-rendering: pixelated;'}
`;
const Rows = styled.ul`margin: 0; padding-left: 1.2rem; list-style: none; font-size: 0.85rem; color: var(--s2-text-muted);`;
const Links = styled.div`display: flex; gap: 1rem; font-size: 0.9rem;`;

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
      </Cols>
    </Modal>
  );
}
