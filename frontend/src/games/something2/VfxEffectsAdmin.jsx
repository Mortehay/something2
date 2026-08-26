import { useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import { HiOutlinePlus, HiOutlineTrash } from 'react-icons/hi2';
import {
  useVfxEffectsAdmin, useCreateVfxEffect, useUpdateVfxEffect, useDeleteVfxEffect,
} from './useVfxEffects.js';
import {
  VFX_SHAPES, VFX_EASES, emptyVfxForm, vfxToForm, vfxFormToPayload, validateVfxForm,
} from './vfxForm.js';
import { drawVfxPreview } from './vfxPreview.js';

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

function Preview({ form }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    let raf = null;
    let start = null;
    const loop = (t) => {
      if (start == null) start = t;
      drawVfxPreview(ctx, canvas.width, canvas.height, vfxFormToPayload(form), t - start);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { if (raf) cancelAnimationFrame(raf); };
    // Re-armed on every field change, which is what makes it LIVE.
  }, [form]);
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

  const save = () => {
    const bad = validateVfxForm(form);
    if (bad) { setError(bad); return; }
    setError(null);
    const body = vfxFormToPayload(form);
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
        {error && <Err role="alert">{error}</Err>}
        <Row>
          <Button onClick={save} disabled={create.isPending || update.isPending}>
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
      <Preview form={form} />
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
      {isLoadingEffects && <p style={{ color: 'var(--s2-text-muted)' }}>Loading…</p>}
      {filteredEffects.map(e => <EffectCard key={e.id} effect={e} />)}
      {!isLoadingEffects && filteredEffects.length === 0 && !adding && (
        <p style={{ color: 'var(--s2-text-muted)' }}>
          {effects && effects.length > 0 ? 'No effects match your filter.' : 'No effects yet.'}
        </p>
      )}
    </AdminContainer>
  );
}

