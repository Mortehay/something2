import { useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import { HiOutlinePlus, HiOutlineTrash } from 'react-icons/hi2';
import {
  useVfxEffectsAdmin, useCreateVfxEffect, useUpdateVfxEffect, useDeleteVfxEffect, uploadVfxSprite,
} from './useVfxEffects.js';
import {
  VFX_SHAPES, VFX_EASES, emptyVfxForm, vfxToForm, vfxFormToPayload, validateVfxForm,
  validateSpriteFile, spriteSheetHint,
} from './vfxForm.js';
import { drawVfxPreview } from './vfxPreview.js';
import { assetUrl } from './src/js/net/assets.js';
import { API_URL } from '../../config.js';
import AdminLoading from './AdminLoading.jsx';

const AdminContainer = styled.div`
  padding: 2rem; color: var(--s2-text); max-width: 1200px; margin: 0 auto;
  height: 100%; overflow-y: auto; background-color: var(--s2-surface);
`;
const Header = styled.div`display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;`;
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
const Input = styled.input`
  background: var(--s2-bg-sunken); color: var(--s2-text); border: 1px solid var(--s2-border-strong);
  border-radius: 4px; padding: 0.4rem; width: ${p => p.$w || '110px'};
`;
const Select = styled.select`
  background: var(--s2-bg-sunken); color: var(--s2-text); border: 1px solid var(--s2-border-strong);
  border-radius: 4px; padding: 0.4rem;
`;
const Label = styled.span`color: var(--s2-text-muted); min-width: 96px;`;
const Err = styled.p`color: var(--s2-danger); margin: 0.4rem 0 0 0; font-size: 0.9rem;`;

// The live preview. This is the reason the slice exists in the form it does:
// "a tweak to duration/colour/particles is visible without entering a world".
// It runs the SAME drawing maths the game does (vfxPreview delegates to the
// pure helpers in core/vfx.js), so what an author sees here is what the canvas
// will draw -- a preview with its own private animation would be a lie that
// looks like a feature.
const PreviewCanvas = styled.canvas`
  width: 220px; height: 160px; border-radius: 6px; border: 1px solid var(--s2-border);
  background: #10131c; /* s2-theme-exempt(#10131c): mirrors the dark game canvas the effect really draws on */
  flex: 0 0 auto;
`;

// `spriteSrc` is what the sprite sheet loads from: a data URL for a file just picked (not yet
// uploaded), else the stored asset's URL, else nothing (the vector shape is previewed).
function useSpriteImage(spriteSrc) {
  const [image, setImage] = useState(null);
  useEffect(() => {
    if (!spriteSrc) { setImage(null); return undefined; }
    let dead = false;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { if (!dead) setImage(img); };
    img.onerror = () => { if (!dead) setImage(null); };
    img.src = spriteSrc;
    return () => { dead = true; };
  }, [spriteSrc]);
  return image;
}

function Preview({ form, image }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    let raf = null;
    let start = null;
    const loop = (t) => {
      if (start == null) start = t;
      drawVfxPreview(ctx, canvas.width, canvas.height, vfxFormToPayload(form), t - start, image);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { if (raf) cancelAnimationFrame(raf); };
    // Re-armed on every field change, which is what makes it LIVE.
  }, [form, image]);
  return <PreviewCanvas ref={ref} width={220} height={160} aria-label="Effect preview" />;
}

function EffectCard({ effect, onDone }) {
  const [form, setForm] = useState(() => (effect ? vfxToForm(effect) : emptyVfxForm()));
  const [error, setError] = useState(null);
  const create = useCreateVfxEffect();
  const update = useUpdateVfxEffect();
  const del = useDeleteVfxEffect();
  const isNew = !effect;
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // A sprite sheet picked but not yet uploaded: kept as the file plus a data URL for the
  // preview. It is uploaded on Save (so an abandoned edit leaves nothing in the asset store).
  const [pendingFile, setPendingFile] = useState(null);
  const [pendingSrc, setPendingSrc] = useState(null);
  const [pendingDims, setPendingDims] = useState(null);
  const [uploading, setUploading] = useState(false);
  const storedSrc = form.sprite_image ? assetUrl(API_URL, form.sprite_image) : null;
  const image = useSpriteImage(pendingSrc || storedSrc);

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
    };
    reader.readAsDataURL(file);
  };
  const clearSprite = () => {
    setPendingFile(null);
    setPendingSrc(null);
    setPendingDims(null);
    setForm(f => ({ ...f, sprite_image: '', sprite_frames: '1', sprite_size: '0', sprite_additive: false }));
  };
  const dims = pendingDims || (image ? { w: image.naturalWidth, h: image.naturalHeight } : null);
  const hint = dims ? spriteSheetHint(dims.w, dims.h, form.sprite_frames) : null;

  const save = async () => {
    const bad = validateVfxForm(form);
    if (bad) { setError(bad); return; }
    setError(null);
    const body = vfxFormToPayload(form);
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
    if (isNew) create.mutate({ body }, { onSuccess: () => onDone && onDone() });
    else update.mutate({ id: effect.id, body });
  };

  return (
    <Card>
      <Fields>
        <Row>
          <Label>Name</Label>
          <Input $w="200px" value={form.name} onChange={e => set('name', e.target.value)} />
          <Label>Shape</Label>
          <Select value={form.shape} onChange={e => set('shape', e.target.value)}>
            {VFX_SHAPES.map(s => <option key={s} value={s}>{s}</option>)}
          </Select>
          <Label>Ease</Label>
          <Select value={form.ease} onChange={e => set('ease', e.target.value)}>
            {VFX_EASES.map(s => <option key={s} value={s}>{s}</option>)}
          </Select>
        </Row>
        <Row>
          <Label>Colour</Label>
          <Input type="color" $w="60px" value={form.color} onChange={e => set('color', e.target.value)} />
          <Label>Width</Label>
          <Input type="number" value={form.width} onChange={e => set('width', e.target.value)} />
          <Label>Duration ms</Label>
          <Input type="number" value={form.duration_ms} onChange={e => set('duration_ms', e.target.value)} />
        </Row>
        <Row>
          <label style={{ color: 'var(--s2-text-secondary)' }}>
            <input type="checkbox" checked={form.fade} onChange={e => set('fade', e.target.checked)} /> fade
          </label>
          <label style={{ color: 'var(--s2-text-secondary)' }}>
            <input
              type="checkbox"
              checked={form.follows_weapon}
              onChange={e => set('follows_weapon', e.target.checked)}
            /> follows weapon
          </label>
        </Row>
        <Row>
          <Label>Particles</Label>
          <Input type="number" value={form.particle_count} onChange={e => set('particle_count', e.target.value)} />
          <Label>Speed</Label>
          <Input type="number" value={form.particle_speed} onChange={e => set('particle_speed', e.target.value)} />
          <Label>Gravity</Label>
          <Input type="number" value={form.particle_gravity} onChange={e => set('particle_gravity', e.target.value)} />
        </Row>
        <Row>
          <Label>Spread rad</Label>
          <Input value={form.particle_spread} onChange={e => set('particle_spread', e.target.value)} />
          <Label>Life ms</Label>
          <Input
            type="number"
            value={form.particle_lifetime_ms}
            onChange={e => set('particle_lifetime_ms', e.target.value)}
          />
          <Label>Size</Label>
          <Input value={form.particle_size} onChange={e => set('particle_size', e.target.value)} />
        </Row>
        <Row>
          <Label>Sprite sheet</Label>
          <input
            type="file"
            accept="image/png"
            aria-label="Sprite sheet PNG"
            onChange={e => { pickSprite(e.target.files && e.target.files[0]); e.target.value = ''; }}
          />
          {(form.sprite_image || pendingFile) && (
            <Button $bg="var(--s2-btn-grey)" onClick={clearSprite}>Remove sprite</Button>
          )}
        </Row>
        {(form.sprite_image || pendingFile) && (
          <Row>
            <Label>Frames</Label>
            <Input type="number" value={form.sprite_frames} onChange={e => set('sprite_frames', e.target.value)} />
            <Label>Size (world)</Label>
            <Input type="number" value={form.sprite_size} onChange={e => set('sprite_size', e.target.value)} />
            <label style={{ color: 'var(--s2-text-secondary)' }}>
              <input
                type="checkbox"
                checked={form.sprite_additive}
                onChange={e => set('sprite_additive', e.target.checked)}
              /> glow (additive)
            </label>
          </Row>
        )}
        {(form.sprite_image || pendingFile) && (
          <p style={{ color: 'var(--s2-text-muted)', margin: '0.2rem 0', fontSize: '0.85rem' }}>
            A horizontal strip of equal frames, played once over the duration. Size 0 = the attack&apos;s own reach.
            {hint ? ` ${hint}.` : ''}{pendingFile ? ' Uploaded when you save.' : ''}
          </p>
        )}
        {error && <Err role="alert">{error}</Err>}
        <Row>
          <Button onClick={save} disabled={create.isPending || update.isPending || uploading}>
            {isNew ? 'Create' : 'Save'}
          </Button>
          {!isNew && (
            <Button
              $bg="var(--s2-danger)"
              onClick={() => del.mutate({ id: effect.id })}
              disabled={del.isPending}
            >
              <HiOutlineTrash /> Delete
            </Button>
          )}
          {isNew && <Button $bg="var(--s2-btn-grey)" onClick={() => onDone && onDone()}>Cancel</Button>}
        </Row>
      </Fields>
      <Preview form={form} image={image} />
    </Card>
  );
}

export default function VfxEffectsAdmin() {
  const { effects, isLoadingEffects } = useVfxEffectsAdmin();
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState('');
  const [shapeFilter, setShapeFilter] = useState('all');

  const filteredEffects = (effects || []).filter(e => {
    if (shapeFilter !== 'all' && e.shape !== shapeFilter) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return (e.name && e.name.toLowerCase().includes(q)) || (e.shape && e.shape.toLowerCase().includes(q));
    }
    return true;
  });

  return (
    <AdminContainer>
      <Header>
        <h1 style={{ margin: 0 }}>Attack Effects</h1>
        <Button onClick={() => setAdding(true)} disabled={adding}>
          <HiOutlinePlus /> New effect
        </Button>
      </Header>
      <p style={{ color: 'var(--s2-text-muted)', marginTop: 0 }}>
        Retune an effect and the change reaches the running game without a deploy. Renaming or
        deleting an effect that a weapon, skill or creature still binds is refused, with the bindings named.
      </p>

      <Row style={{ marginBottom: '1.2rem', gap: '0.8rem' }}>
        <Input
          placeholder="Search effects..."
          $w="240px"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <Select value={shapeFilter} onChange={e => setShapeFilter(e.target.value)}>
          <option value="all">All Shapes ({effects ? effects.length : 0})</option>
          {VFX_SHAPES.map(s => (
            <option key={s} value={s}>
              {s.toUpperCase()} ({effects ? effects.filter(e => e.shape === s).length : 0})
            </option>
          ))}
        </Select>
      </Row>

      {adding && <EffectCard effect={null} onDone={() => setAdding(false)} />}
      {isLoadingEffects && <AdminLoading label="Loading effects…" inline size={16} />}
      {filteredEffects.map(e => <EffectCard key={e.id} effect={e} />)}
      {!isLoadingEffects && filteredEffects.length === 0 && !adding && (
        <p style={{ color: 'var(--s2-text-muted)' }}>
          {effects && effects.length > 0 ? 'No effects match your filter.' : 'No effects yet.'}
        </p>
      )}
    </AdminContainer>
  );
}

