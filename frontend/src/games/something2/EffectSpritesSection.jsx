import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import styled from 'styled-components';
import { assetUrl } from './useTileSprites.js';
import { spriteFrameAtTime } from './src/js/core/vfx.js';
import { waitLabel } from './spriteSelection.js';
import {
  effectKey, previewAngles, effectSelectionEta, effectEtaLabel, effectStatusLabel, previewSprite,
} from './effectSprites.js';
import { useEffectSprites, useQueueEffects, useApproveEffect, useResumeEffects } from './useSpriteConsole.js';

const Section = styled.section`margin-top: 2rem;`;
const Bar = styled.div`display: flex; gap: 0.75rem; flex-wrap: wrap; align-items: center; margin: 0.75rem 0;`;
const Hint = styled.p`margin: 0.35rem 0; color: var(--s2-text-muted); font-size: 0.85rem;`;
const Button = styled.button`
  border: 0; border-radius: 6px; padding: 0.35rem 0.8rem; cursor: pointer;
  color: var(--s2-on-accent); background: var(--s2-accent); font-weight: 700;
  &:disabled { opacity: 0.5; cursor: default; }
`;
const Secondary = styled(Button)`background: var(--s2-btn-grey);`;
const TableWrap = styled.div`
  overflow-x: auto; border: 1px solid var(--s2-border); border-radius: 8px; background: var(--s2-surface-raised);
`;
const Table = styled.table`
  width: 100%; border-collapse: collapse; font-size: 0.85rem;
  th, td { text-align: left; padding: 0.45rem 0.6rem; border-bottom: 1px solid var(--s2-border); vertical-align: middle; }
  th { color: var(--s2-text-muted); font-weight: 500; }
  tr[data-group-row] td { background: var(--s2-bg-sunken); font-weight: 700; }
  textarea {
    width: 100%; min-width: 220px; min-height: 3.2rem; padding: 0.3rem; color: var(--s2-text);
    background: var(--s2-bg-sunken); border: 1px solid var(--s2-border-strong); border-radius: 4px; font: inherit;
  }
`;
const Swatch = styled.span`
  display: inline-block; width: 1rem; height: 1rem; border-radius: 3px; border: 1px solid var(--s2-border-strong);
`;
const Thumb = styled.button`
  width: 40px; height: 40px; padding: 0; border: 1px solid var(--s2-border-strong); border-radius: 4px; cursor: pointer;
  background: #101018 no-repeat left center; image-rendering: pixelated;
`;
const Overlay = styled.div`
  position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.6);
`;
const Panel = styled.div`
  padding: 1rem; border-radius: 8px; background: var(--s2-surface-raised); color: var(--s2-text);
  max-width: 90vw; display: flex; flex-direction: column; gap: 0.5rem;
`;

const CELL = 192;
const GAP_MS = 400;

// Loops the strip the way the game plays it, once per preview angle. Additive effects
// go on a dark background with 'lighter'; alpha-blended ones on mid-grey so dark art shows.
export function EffectStripPreview({ subject, onClose }) {
  const ref = useRef(null);
  const sprite = previewSprite(subject);
  const additive = subject.blend === 'additive';
  const angles = previewAngles(subject.kind);
  useEffect(() => {
    if (!sprite || typeof Image === 'undefined') return undefined;
    const img = new Image();
    img.src = assetUrl(sprite.image_key);
    const def = { sprite_frames: sprite.frames, sprite_loop: sprite.loop === true, sprite_fps: sprite.fps };
    const frames = Math.max(1, Number(sprite.frames) || 1);
    const duration = sprite.fps > 0 ? (frames * 1000) / sprite.fps : 800;
    let raf = 0;
    const t0 = performance.now();
    const draw = (now) => {
      const canvas = ref.current;
      const ctx = canvas && canvas.getContext('2d');
      if (ctx && img.complete && img.naturalWidth) {
        const period = sprite.loop === true ? duration : duration + GAP_MS;
        const elapsed = sprite.loop === true ? now - t0 : (now - t0) % period;
        const f = spriteFrameAtTime(def, elapsed, duration);
        const fw = img.naturalWidth / frames;
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = additive ? '#101018' : '#808080';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (additive) ctx.globalCompositeOperation = 'lighter';
        angles.forEach((deg, i) => {
          ctx.save();
          ctx.translate(CELL * (i + 0.5), CELL / 2);
          ctx.rotate((deg * Math.PI) / 180);
          ctx.drawImage(img, f * fw, 0, fw, img.naturalHeight, -CELL / 2, -CELL / 2, CELL, CELL);
          ctx.restore();
        });
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [sprite?.image_key, sprite?.frames, sprite?.loop, sprite?.fps, additive, angles.length]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Overlay onClick={onClose}>
      <Panel onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`${subject.name} preview`}>
        <strong>{subject.name}</strong>
        <canvas ref={ref} width={CELL * angles.length} height={CELL} style={{ maxWidth: '100%' }} />
        <Hint>{additive ? 'Additive blend on a dark background.' : 'Alpha blend on a grey background.'}</Hint>
        <Secondary onClick={onClose}>Close</Secondary>
      </Panel>
    </Overlay>
  );
}

function thumbStyle(sprite) {
  const frames = Math.max(1, Number(sprite.frames) || 1);
  return { backgroundImage: `url(${assetUrl(sprite.image_key)})`, backgroundSize: `${frames * 100}% 100%` };
}

export function EffectSpritesTable({ subjects, selected, prompts, onToggle, onPrompt, onGenerate, onApprove, onPreview }) {
  const groups = [];
  for (const s of subjects) {
    let g = groups.find((x) => x.name === s.group);
    if (!g) { g = { name: s.group, rows: [] }; groups.push(g); }
    g.rows.push(s);
  }
  return (
    <TableWrap>
      <Table>
        <thead>
          <tr><th /><th>Name</th><th>Colour</th><th>Sprite</th><th>Status</th><th>Prompt</th><th /></tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <Fragment key={g.name}>
              <tr data-group-row><td colSpan={7}>{g.name}</td></tr>
              {g.rows.map((s) => {
                const key = effectKey(s);
                const shown = previewSprite(s);
                const redraw = !!s.sprite || s.job?.status === 'done';
                return (
                  <tr key={key}>
                    <td><input type="checkbox" aria-label={`Select ${s.name}`} checked={selected.has(key)} onChange={() => onToggle(key)} /></td>
                    <td>{s.name}</td>
                    <td>{s.color ? <Swatch style={{ background: s.color }} title={s.color} /> : '—'}</td>
                    <td>
                      {shown
                        ? <Thumb type="button" aria-label={`Preview ${s.name}`} style={thumbStyle(shown)} onClick={() => onPreview(s)} />
                        : 'none'}
                    </td>
                    <td>{effectStatusLabel(s)}</td>
                    <td>
                      <textarea aria-label={`Prompt for ${s.name}`} maxLength={1000}
                        value={prompts[key] ?? s.default_prompt ?? ''} onChange={(e) => onPrompt(key, e.target.value)} />
                    </td>
                    <td>
                      <Button type="button" disabled={s.missing} onClick={() => onGenerate([s])}>{redraw ? 'Redraw' : 'Generate'}</Button>{' '}
                      <Secondary type="button" disabled={s.job?.status !== 'done'} onClick={() => onApprove(s)}>Approve</Secondary>
                    </td>
                  </tr>
                );
              })}
            </Fragment>
          ))}
        </tbody>
      </Table>
    </TableWrap>
  );
}

export default function EffectSpritesSection({ boxQueue }) {
  const { subjects, eta, dispatcher, isLoading, error } = useEffectSprites();
  const queue = useQueueEffects();
  const approve = useApproveEffect();
  const resume = useResumeEffects();
  const [selected, setSelected] = useState(() => new Set());
  const [prompts, setPrompts] = useState({});
  const [preview, setPreview] = useState(null);
  const est = useMemo(() => effectEtaLabel(effectSelectionEta(subjects, selected, eta)), [subjects, selected, eta]);
  const anyQueued = subjects.some((s) => s.job?.status === 'queued');
  const toggle = (key) => setSelected((cur) => { const n = new Set(cur); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const generate = (rows) => queue.mutate({
    targets: rows.map((s) => {
      const text = prompts[effectKey(s)];
      return { subject_kind: s.subject_kind, name: s.name, ...(text != null && text.trim() ? { prompt: text.trim() } : {}) };
    }),
  });
  const previewing = preview && subjects.find((s) => effectKey(s) === preview);
  return (
    <Section>
      <h3>Effects</h3>
      <Hint>Auras, bolts, impacts and beams drawn on the GPU box one at a time. Approve a finished strip to use it in game.</Hint>
      {isLoading && <Hint>Loading effects…</Hint>}
      {error && <Hint role="alert">{error.message}</Hint>}
      <Bar>
        <Button disabled={selected.size === 0 || queue.isPending}
          onClick={() => generate(subjects.filter((s) => selected.has(effectKey(s))))}>
          Generate {selected.size} selected
        </Button>
        {selected.size > 0 && <Hint>{est} · {waitLabel(boxQueue)}</Hint>}
        {anyQueued && dispatcher && !dispatcher.running && (
          <Secondary disabled={resume.isPending} onClick={() => resume.mutate()}>Resume queue</Secondary>
        )}
      </Bar>
      <EffectSpritesTable subjects={subjects} selected={selected} prompts={prompts}
        onToggle={toggle} onPrompt={(k, v) => setPrompts((p) => ({ ...p, [k]: v }))}
        onGenerate={generate} onApprove={(s) => approve.mutate({ id: s.job.id })}
        onPreview={(s) => setPreview(effectKey(s))} />
      {previewing && <EffectStripPreview subject={previewing} onClose={() => setPreview(null)} />}
    </Section>
  );
}
