import { useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import { useQueryClient } from '@tanstack/react-query';
import { useBuffVisualsAdmin, useUpdateBuffVisual, BUFF_VISUALS_QUERY_KEY } from './useBuffVisuals.js';
import { useUpdateGameSetting } from './useGameSettings.js';
import { uploadVfxSprite } from './useVfxEffects.js';
import {
  BUFF_PLACEMENTS, buffToForm, buffFormToPayload, validateBuffForm, clearedBuffSpriteForm, touchBuffSprite, afterSaveTouched,
  buffClass, filterBuffVisuals,
} from './buffVisualForm.js';
import { validateSpriteFile, spriteSheetHint, vfxSpriteFilter } from './vfxForm.js';
import { useSpriteImage, spriteCaption, PreviewPair, PreviewCol, PreviewLabel } from './VfxEffectsAdmin.jsx';
import { assetUrl } from './src/js/net/assets.js';
import { API_URL } from '../../config.js';
import { drawBuffAuraPreview } from './buffAuraPreview.js';
import { SKILLS_BY_CLASS } from './src/js/core/skillsData.js';
import AdminLoading from './AdminLoading.jsx';

const CLASSES = Object.keys(SKILLS_BY_CLASS);
const OPACITY_KEYS = [
  { key: 'buff_visual_main_opacity', field: 'main_opacity', label: 'Main buff', fallback: 0.85 },
  { key: 'buff_visual_other_opacity', field: 'other_opacity', label: 'Other buffs', fallback: 0.45 },
];

const AdminContainer = styled.div`
  padding: 2rem; color: var(--s2-text); max-width: 1200px; margin: 0 auto;
  height: 100%; overflow-y: auto; background-color: var(--s2-surface);
`;
const Button = styled.button`
  background: ${p => p.$bg || 'var(--s2-accent)'}; color: var(--s2-on-accent); border: none; border-radius: 6px;
  padding: 0.5rem 1rem; font-weight: bold; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
  &:disabled { opacity: 0.5; cursor: default; }
`;
const Card = styled.div`
  background: var(--s2-surface-raised); border: 1px solid var(--s2-border); border-radius: 8px;
  padding: 1rem; margin-bottom: 1rem; display: flex; gap: 1rem; align-items: flex-start;
`;
const Fields = styled.div`flex: 1; min-width: 0;`;
const Row = styled.div`display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; margin: 0.4rem 0;`;
const SectionTitle = styled.h3`
  margin: 0 0 0.2rem 0; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--s2-text-muted);
`;
const Name = styled.h2`margin: 0; font-size: 1.05rem;`;
const Hint = styled.span`color: var(--s2-text-muted); font-size: 0.85rem;`;
const Input = styled.input`
  background: var(--s2-bg-sunken); color: var(--s2-text); border: 1px solid var(--s2-border-strong);
  border-radius: 4px; padding: 0.4rem; width: ${p => p.$w || '110px'};
  &:disabled { opacity: 0.5; }
`;
const Select = styled.select`
  background: var(--s2-bg-sunken); color: var(--s2-text); border: 1px solid var(--s2-border-strong);
  border-radius: 4px; padding: 0.4rem;
`;
const Label = styled.span`color: var(--s2-text-muted); min-width: 72px;`;
const Err = styled.p`color: var(--s2-danger); margin: 0.4rem 0 0 0; font-size: 0.9rem;`;
const Bar = styled.div`
  background: var(--s2-surface-raised); border: 1px solid var(--s2-border); border-radius: 8px;
  padding: 0.75rem 1rem; margin-bottom: 1.2rem;
`;
const PreviewCanvas = styled.canvas`
  width: 220px; height: 160px; border-radius: 6px; border: 1px solid var(--s2-border);
  background: #10131c; /* s2-theme-exempt(#10131c): mirrors the dark game canvas the aura really draws on */
  flex: 0 0 auto;
`;

// Two canvases on ONE requestAnimationFrame clock: Code (the fallback ring or glow) and Sprite
// (the sheet over a faint fallback). Re-armed on every field change, which makes it live.
function Preview({ form, image, failed, auraRadius }) {
  const codeRef = useRef(null);
  const spriteRef = useRef(null);
  const captionRef = useRef(null);
  captionRef.current = spriteCaption({ hasSprite: !!form.sprite_image || !!image, failed });
  useEffect(() => {
    const codeCanvas = codeRef.current;
    const spriteCanvas = spriteRef.current;
    if (!codeCanvas || !spriteCanvas) return undefined;
    const codeCtx = codeCanvas.getContext('2d');
    const spriteCtx = spriteCanvas.getContext('2d');
    // aura_radius rides along so a buff with its own effect radius previews at it, as in game.
    const visual = { ...buffFormToPayload({ ...form, sprite_touched: true }), aura_radius: auraRadius };
    let raf = null;
    let start = null;
    const loop = (t) => {
      if (start == null) start = t;
      const elapsed = t - start;
      drawBuffAuraPreview(codeCtx, codeCanvas.width, codeCanvas.height, visual, elapsed);
      if (image) {
        drawBuffAuraPreview(spriteCtx, spriteCanvas.width, spriteCanvas.height, visual, elapsed, image, { reference: true });
      } else {
        spriteCtx.clearRect(0, 0, spriteCanvas.width, spriteCanvas.height);
        spriteCtx.save();
        spriteCtx.fillStyle = '#8a93a6'; // s2-theme-exempt(#8a93a6): caption on the dark game canvas
        spriteCtx.font = '14px sans-serif';
        spriteCtx.textAlign = 'center';
        spriteCtx.textBaseline = 'middle';
        spriteCtx.fillText(captionRef.current || 'sprite loading', spriteCanvas.width / 2, spriteCanvas.height / 2);
        spriteCtx.restore();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { if (raf) cancelAnimationFrame(raf); };
  }, [form, image, auraRadius]);
  return (
    <PreviewPair>
      <PreviewCol>
        <PreviewCanvas ref={codeRef} width={220} height={160} aria-label="Buff aura preview (code)" />
        <PreviewLabel>Code</PreviewLabel>
      </PreviewCol>
      <PreviewCol>
        <PreviewCanvas ref={spriteRef} width={220} height={160} aria-label="Buff aura preview (sprite)" />
        <PreviewLabel>Sprite</PreviewLabel>
      </PreviewCol>
    </PreviewPair>
  );
}

// The two game_settings opacities, saved through the existing /api/settings write. The public
// buff-visuals read carries them too, so it is refetched after a save; the parent keys this bar
// by the stored values, so a refetch resets the drafts to what the server holds.
function OpacityBar({ settings }) {
  const qc = useQueryClient();
  const update = useUpdateGameSetting();
  const stored = (o) => String(settings && settings[o.field] != null ? settings[o.field] : o.fallback);
  const [draft, setDraft] = useState(() => Object.fromEntries(OPACITY_KEYS.map(o => [o.key, stored(o)])));
  const [error, setError] = useState(null);

  const save = (o) => {
    const raw = String(draft[o.key] ?? '').trim();
    const value = raw === '' ? NaN : Number(raw);
    if (!(Number.isFinite(value) && value >= 0 && value <= 1)) { setError(`${o.label} opacity must be between 0 and 1`); return; }
    setError(null);
    update.mutate({ key: o.key, value }, { onSuccess: () => qc.invalidateQueries({ queryKey: BUFF_VISUALS_QUERY_KEY }) });
  };

  return (
    <Bar>
      <SectionTitle>Opacity</SectionTitle>
      <Row>
        {OPACITY_KEYS.map(o => (
          <span key={o.key} style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center' }}>
            <Label>{o.label}</Label>
            <Input
              type="number" step="0.05" min="0" max="1" $w="80px" aria-label={`${o.label} opacity`}
              value={draft[o.key]} onChange={e => setDraft(d => ({ ...d, [o.key]: e.target.value }))}
            />
            <Button onClick={() => save(o)} disabled={update.isPending}>Save</Button>
          </span>
        ))}
      </Row>
      <Hint>One active buff always draws fully opaque. With two or more, the main buff uses the first value, every other buff the second.</Hint>
      {error && <Err role="alert">{error}</Err>}
    </Bar>
  );
}

function BuffCard({ visual }) {
  const [form, setForm] = useState(() => buffToForm(visual));
  const [error, setError] = useState(null);
  const update = useUpdateBuffVisual();
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const setSprite = (k, v) => setForm(f => touchBuffSprite(f, { [k]: v }));

  // A sheet picked but not yet uploaded: uploaded on Save, so an abandoned edit leaves nothing
  // in the asset store.
  const [pendingFile, setPendingFile] = useState(null);
  const [pendingSrc, setPendingSrc] = useState(null);
  const [pendingDims, setPendingDims] = useState(null);
  const [uploading, setUploading] = useState(false);
  const storedSrc = form.sprite_image ? assetUrl(API_URL, form.sprite_image) : null;
  const { image, failed: spriteFailed } = useSpriteImage(pendingSrc || storedSrc);

  const pickSprite = (file) => {
    if (!file) return;
    const bad = validateSpriteFile(file);
    if (bad) { setError(bad); return; }
    setError(null);
    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result || '');
      const probe = new Image();
      probe.onload = () => setPendingDims({ w: probe.naturalWidth, h: probe.naturalHeight });
      probe.src = src;
      setPendingFile(file);
      setPendingSrc(src);
      setForm(f => touchBuffSprite(f));
    };
    reader.readAsDataURL(file);
  };
  const clearSprite = () => {
    setPendingFile(null);
    setPendingSrc(null);
    setPendingDims(null);
    setForm(clearedBuffSpriteForm);
  };
  const dims = pendingDims || (image ? { w: image.naturalWidth, h: image.naturalHeight } : null);
  const hint = dims ? spriteSheetHint(dims.w, dims.h, form.sprite_frames) : null;
  const hasSprite = !!(form.sprite_image || pendingFile);
  const ground = form.placement === 'ground';

  const save = async () => {
    // A picked-but-not-yet-uploaded sheet has no key yet; validate as if it had one.
    const bad = validateBuffForm(pendingFile ? { ...form, sprite_image: 'pending' } : form);
    if (bad) { setError(bad); return; }
    setError(null);
    const body = buffFormToPayload(form);
    if (pendingFile) {
      setUploading(true);
      try {
        const up = await uploadVfxSprite(pendingFile);
        body.sprite_image = up.key;
        setForm(f => ({ ...f, sprite_image: up.key }));
        setPendingFile(null);
        setPendingSrc(null);
      } catch (e) {
        setError(e.message);
        return;
      } finally {
        setUploading(false);
      }
    }
    // `form` is the snapshot the body was built from; a sprite edit made while the save was in
    // flight keeps the sprite touched (afterSaveTouched), anything else clears it.
    const formAtSave = form;
    update.mutate({ skillId: visual.skill_id, body }, {
      onSuccess: () => setForm(f => ({ ...f, sprite_touched: afterSaveTouched(formAtSave, f) })),
    });
  };

  return (
    <Card>
      <Fields>
        <Row>
          <Name>{visual.name_en || visual.skill_id}</Name>
          <Hint>{buffClass(visual.skill_id) || 'unknown class'} · tier {visual.tier ?? '—'} · lvl {visual.req_lvl ?? '—'} · {visual.skill_id}</Hint>
        </Row>
        <Row>
          <Label>Placement</Label>
          <Select value={form.placement} onChange={e => set('placement', e.target.value)} aria-label="Placement">
            {BUFF_PLACEMENTS.map(p => <option key={p} value={p}>{p}</option>)}
          </Select>
          {ground ? (
            <>
              <Label>Radius</Label>
              <Input type="number" step="any" value={form.radius} onChange={e => set('radius', e.target.value)} />
            </>
          ) : (
            <>
              <Label>Scale ×</Label>
              <Input type="number" step="0.05" value={form.scale} onChange={e => set('scale', e.target.value)} />
            </>
          )}
          <Label>Priority</Label>
          <Input type="number" step="1" placeholder="none" value={form.priority} onChange={e => set('priority', e.target.value)} />
          <Label>Colour</Label>
          <Input type="color" $w="60px" value={form.color} onChange={e => set('color', e.target.value)} />
        </Row>
        <Row>
          <Hint>
            {ground
              ? (visual.aura_radius
                ? `Ground: lies flat at the feet, drawn at the buff's own effect radius ${visual.aura_radius} (Radius is not used).`
                : 'Ground: lies flat at the feet, Radius world units out.')
              : 'Body: a shell around the figure, Scale × the character height.'}
            {' '}Priority picks the main buff when several are active (empty = lowest).
          </Hint>
        </Row>
        <Row>
          <Label>Sprite</Label>
          <input
            type="file"
            accept="image/png"
            aria-label="Sprite sheet PNG"
            onChange={e => { pickSprite(e.target.files && e.target.files[0]); e.target.value = ''; }}
          />
          {hasSprite && <Button $bg="var(--s2-btn-grey)" onClick={clearSprite}>Remove sprite</Button>}
        </Row>
        {hasSprite && (
          <Row>
            <Label>Frames</Label>
            <Input type="number" value={form.sprite_frames} onChange={e => setSprite('sprite_frames', e.target.value)} />
            <Label>FPS</Label>
            <Input
              type="number" placeholder="10" value={form.sprite_fps}
              onChange={e => setSprite('sprite_fps', e.target.value)}
            />
            <label style={{ color: 'var(--s2-text-secondary)' }}>
              <input
                type="checkbox"
                checked={form.sprite_additive}
                onChange={e => setSprite('sprite_additive', e.target.checked)}
              /> glow (additive)
            </label>
          </Row>
        )}
        {hasSprite && (
          <p style={{ color: 'var(--s2-text-muted)', margin: '0.2rem 0', fontSize: '0.85rem' }}>
            A horizontal strip of equal frames, looping. Empty FPS = 10.{hint ? ` ${hint}.` : ''}{pendingFile ? ' Uploaded when you save.' : ''}
          </p>
        )}
        {error && <Err role="alert">{error}</Err>}
        <Row>
          <Button onClick={save} disabled={update.isPending || uploading}>Save</Button>
        </Row>
      </Fields>
      <Preview form={form} image={image} failed={spriteFailed} auraRadius={visual.aura_radius ?? null} />
    </Card>
  );
}

export default function BuffAurasAdmin() {
  const { visuals, settings, isLoadingVisuals, isVisualsError } = useBuffVisualsAdmin();
  const [search, setSearch] = useState('');
  const [cls, setCls] = useState('all');
  const [spriteFilter, setSpriteFilter] = useState('all');

  const filtered = filterBuffVisuals(vfxSpriteFilter(visuals, spriteFilter), { search, cls });

  return (
    <AdminContainer>
      <h1 style={{ marginTop: 0 }}>Buff Auras</h1>
      <p style={{ color: 'var(--s2-text-muted)', marginTop: 0 }}>
        How each active buff draws on a character. One card per visual buff skill; druid forms and traps have none.
        Sprites can also be drawn on the GPU box from the Sprite tab (group &quot;Buff auras&quot;).
      </p>

      {!isLoadingVisuals && !isVisualsError && <OpacityBar key={settings ? `${settings.main_opacity}|${settings.other_opacity}` : ''} settings={settings} />}

      <Row style={{ marginBottom: '1.2rem', gap: '0.8rem' }}>
        <Input placeholder="Search buffs..." $w="240px" value={search} onChange={e => setSearch(e.target.value)} />
        <Select value={cls} onChange={e => setCls(e.target.value)} aria-label="Class filter">
          <option value="all">All classes ({visuals.length})</option>
          {CLASSES.map(c => (
            <option key={c} value={c}>{c} ({visuals.filter(v => buffClass(v.skill_id) === c).length})</option>
          ))}
        </Select>
        <Select value={spriteFilter} onChange={e => setSpriteFilter(e.target.value)} aria-label="Sprite filter">
          <option value="all">All sprites</option>
          <option value="with">With sprite</option>
          <option value="without">Without sprite</option>
        </Select>
      </Row>

      {isLoadingVisuals && <AdminLoading label="Loading buff auras…" inline size={16} />}
      {filtered.map(v => <BuffCard key={v.skill_id} visual={v} />)}
      {isVisualsError && !isLoadingVisuals && (
        <p style={{ color: 'var(--s2-danger)' }}>Could not load the buff auras.</p>
      )}
      {!isLoadingVisuals && !isVisualsError && filtered.length === 0 && (
        <p style={{ color: 'var(--s2-text-muted)' }}>
          {visuals.length > 0 ? 'No buffs match your filter.' : 'No visual buffs.'}
        </p>
      )}
    </AdminContainer>
  );
}
