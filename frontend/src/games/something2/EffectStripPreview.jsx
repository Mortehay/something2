import { useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import { assetUrl } from './useTileSprites.js';
import { previewAngles, previewFrameAt, previewSprite, effectStatusLabel } from './effectSprites.js';

const Hint = styled.p`margin: 0.35rem 0; color: var(--s2-text-muted); font-size: 0.85rem;`;
const Button = styled.button`
  border: 0; border-radius: 6px; padding: 0.35rem 0.8rem; cursor: pointer;
  color: var(--s2-on-accent); background: var(--s2-accent); font-weight: 700;
  &:disabled { opacity: 0.5; cursor: default; }
`;
const Secondary = styled(Button)`background: var(--s2-btn-grey);`;
const Buttons = styled.div`display: flex; gap: 0.5rem; flex-wrap: wrap;`;
const Overlay = styled.div`
  position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.6);
`;
const Panel = styled.div`
  padding: 1rem; border-radius: 8px; background: var(--s2-surface-raised); color: var(--s2-text);
  max-width: 90vw; display: flex; flex-direction: column; gap: 0.5rem;
`;

const CELL = 192;

// Shared by the preview dialog and the table thumbnails: additive art sits on dark,
// alpha-blended art on mid-grey so dark art stays visible.
export const effectBackground = (blend) => (blend === 'additive' ? '#101018' : '#808080');

// A table thumbnail: the strip's first frame on the blend's background.
export function effectThumbStyle(sprite, blend) {
  const frames = Math.max(1, Number(sprite.frames) || 1);
  return { backgroundColor: effectBackground(blend), backgroundImage: `url(${assetUrl(sprite.image_key)})`, backgroundSize: `${frames * 100}% 100%` };
}

// Loops the strip the way the game plays it, once per preview angle. Additive effects
// go on a dark background with 'lighter'; alpha-blended ones on mid-grey so dark art shows.
// A done candidate plays by its own job atlas (previewSprite). onRedraw queues the
// effect again with the job's frames/loop; onApprove approves a done candidate.
export function EffectStripPreview({ subject, onClose, onRedraw = null, onApprove = null, pending = false }) {
  const ref = useRef(null);
  const sprite = previewSprite(subject);
  const additive = subject.blend === 'additive';
  const angles = previewAngles(subject.kind);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    if (!sprite || typeof Image === 'undefined') return undefined;
    const img = new Image();
    let raf = 0;
    img.onerror = () => { cancelAnimationFrame(raf); setFailed(true); };
    img.src = assetUrl(sprite.image_key);
    const frames = Math.max(1, Number(sprite.frames) || 1);
    const t0 = performance.now();
    const draw = (now) => {
      const canvas = ref.current;
      const ctx = canvas && canvas.getContext('2d');
      if (ctx && img.complete && img.naturalWidth) {
        const f = previewFrameAt(sprite, now, t0);
        const fw = img.naturalWidth / frames;
        const fh = img.naturalHeight;
        const scale = Math.min(CELL / fw, CELL / fh);
        const dw = fw * scale;
        const dh = fh * scale;
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = effectBackground(subject.blend);
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (additive) ctx.globalCompositeOperation = 'lighter';
        angles.forEach((deg, i) => {
          ctx.save();
          ctx.translate(CELL * (i + 0.5), CELL / 2);
          ctx.rotate((deg * Math.PI) / 180);
          ctx.drawImage(img, f * fw, 0, fw, fh, -dw / 2, -dh / 2, dw, dh);
          ctx.restore();
        });
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [sprite?.image_key, sprite?.frames, sprite?.loop, sprite?.fps, additive, angles.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const status = effectStatusLabel(subject);
  return (
    <Overlay onClick={onClose}>
      <Panel onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`${subject.name} preview`}>
        <strong>{subject.name}</strong>
        <Hint>{status}</Hint>
        {failed && <Hint role="alert">image failed to load</Hint>}
        <canvas ref={ref} width={CELL * angles.length} height={CELL} style={{ maxWidth: '100%' }} />
        <Hint>{additive ? 'Additive blend on a dark background.' : 'Alpha blend on a grey background.'}</Hint>
        <Buttons>
          {onApprove && <Button type="button" disabled={pending || status !== 'ready to approve'} onClick={onApprove}>Approve</Button>}
          {onRedraw && <Secondary type="button" disabled={pending || subject.missing} onClick={onRedraw}>Redraw</Secondary>}
          <Secondary type="button" onClick={onClose}>Close</Secondary>
        </Buttons>
      </Panel>
    </Overlay>
  );
}

// What the preview's Redraw queues: the effect again with its job's frames and
// loop (an aura always loops and a burst never does, so loop is never sent for them).
export function effectRedrawTarget(subject) {
  const t = { subject_kind: subject.subject_kind, name: subject.name };
  const frames = subject.job?.frames;
  if (Number.isInteger(frames)) t.frames = frames;
  const loop = subject.job?.loop;
  if (typeof loop === 'boolean' && (subject.kind === 'projectile' || subject.kind === 'beam')) t.loop = loop;
  return t;
}

export default EffectStripPreview;
