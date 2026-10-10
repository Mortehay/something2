import { useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import { HiOutlinePlus, HiOutlineTrash } from 'react-icons/hi2';
import {
  useAuraEffectsAdmin, useCreateAuraEffect, useUpdateAuraEffect, useDeleteAuraEffect,
} from './useAuraEffects.js';
import {
  AURA_SIDES, AURA_SHAPES, AURA_ELEMENTS, emptyAuraForm, auraToForm, auraFormToPayload, validateAuraForm,
} from './auraForm.js';
import { drawAuraPreview } from './auraPreview.js';
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
const SectionTitle = styled.h3`
  margin: 0.8rem 0 0.2rem 0; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--s2-text-muted);
`;
const Hint = styled.span`color: var(--s2-text-muted); font-size: 0.85rem;`;
const Input = styled.input`
  background: var(--s2-bg-sunken); color: var(--s2-text); border: 1px solid var(--s2-border-strong);
  border-radius: 4px; padding: 0.4rem; width: ${p => p.$w || '110px'};
  &:disabled { opacity: 0.5; }
`;
const Select = styled.select`
  background: var(--s2-bg-sunken); color: var(--s2-text); border: 1px solid var(--s2-border-strong);
  border-radius: 4px; padding: 0.4rem;
  &:disabled { opacity: 0.5; }
`;
const Label = styled.span`color: var(--s2-text-muted); min-width: 96px;`;
const Err = styled.p`color: var(--s2-danger); margin: 0.4rem 0 0 0; font-size: 0.9rem;`;
const PreviewCanvas = styled.canvas`
  width: 220px; height: 160px; border-radius: 6px; border: 1px solid var(--s2-border);
  background: #10131c; /* s2-theme-exempt(#10131c): mirrors the dark game canvas the aura really draws on */
  flex: 0 0 auto;
`;

// Re-armed on every field change, which is what makes it LIVE. Uses the same
// maths the in-game renderer must (core/auraVisual.js).
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
      drawAuraPreview(ctx, canvas.width, canvas.height, auraFormToPayload(form), t - start);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { if (raf) cancelAnimationFrame(raf); };
  }, [form]);
  return <PreviewCanvas ref={ref} width={220} height={160} aria-label="Aura preview" />;
}

function AuraCard({ aura, onDone }) {
  const [form, setForm] = useState(() => (aura ? auraToForm(aura) : emptyAuraForm()));
  const [error, setError] = useState(null);
  const create = useCreateAuraEffect();
  const update = useUpdateAuraEffect();
  const del = useDeleteAuraEffect();
  const isNew = !aura;
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const num = (k, w) => (
    <Input type="number" step="any" $w={w} value={form[k]} onChange={e => set(k, e.target.value)} />
  );
  const usedBy = (aura && aura.used_by) || [];
  const isAllies = form.target_side === 'allies';

  const save = () => {
    const bad = validateAuraForm(form);
    if (bad) { setError(bad); return; }
    setError(null);
    const body = auraFormToPayload(form);
    if (isNew) create.mutate({ body }, { onSuccess: () => onDone && onDone() });
    else update.mutate({ id: aura.id, body });
  };

  return (
    <Card>
      <Fields>
        <SectionTitle>Target</SectionTitle>
        <Row>
          <Label>Name</Label>
          <Input $w="200px" value={form.name} onChange={e => set('name', e.target.value)} />
          <Label>Side</Label>
          <Select value={form.target_side} onChange={e => set('target_side', e.target.value)}>
            {AURA_SIDES.map(s => <option key={s} value={s}>{s}</option>)}
          </Select>
          <Label>Radius</Label>
          {num('radius')}
        </Row>
        <SectionTitle>Modifiers</SectionTitle>
        <Row>
          <Label>Damage ×</Label>
          {num('damage_mult')}
          <Label>Defense ×</Label>
          {num('defense_mult')}
          <Label>Speed ×</Label>
          {num('speed_mult')}
        </Row>
        <Row>
          <Hint>allies: &gt;1 buffs; enemies: &lt;1 weakens (enemy side is live from S4)</Hint>
        </Row>
        <SectionTitle>Damage over time</SectionTitle>
        <Row>
          <Label>DPS</Label>
          <Input
            type="number" step="any" value={form.dot_dps} disabled={isAllies}
            onChange={e => set('dot_dps', e.target.value)}
          />
          <Label>Element</Label>
          <Select value={form.dot_element} disabled={isAllies} onChange={e => set('dot_element', e.target.value)}>
            {AURA_ELEMENTS.map(s => <option key={s} value={s}>{s}</option>)}
          </Select>
          <Label>Tick ms</Label>
          <Input
            type="number" value={form.tick_ms} disabled={isAllies}
            onChange={e => set('tick_ms', e.target.value)}
          />
          {isAllies && <Hint>enemies only</Hint>}
        </Row>
        <SectionTitle>Visual</SectionTitle>
        <Row>
          <Label>Shape</Label>
          <Select value={form.shape} onChange={e => set('shape', e.target.value)}>
            {AURA_SHAPES.map(s => <option key={s} value={s}>{s}</option>)}
          </Select>
          <Label>Colour</Label>
          <Input type="color" $w="60px" value={form.color} onChange={e => set('color', e.target.value)} />
          <Label>Pulse ms</Label>
          {num('pulse_ms')}
        </Row>
        <Row>
          <Label>Particles</Label>
          {num('particle_count')}
          <Label>Spread rad</Label>
          {num('particle_spread')}
          <Label>Speed</Label>
          {num('particle_speed')}
        </Row>
        <Row>
          <Label>Gravity</Label>
          {num('particle_gravity')}
          <Label>Life ms</Label>
          {num('particle_lifetime_ms')}
          <Label>Size</Label>
          {num('particle_size')}
        </Row>
        {!isNew && (
          <Row>
            <Hint>
              {usedBy.length > 0
                ? `Used by (${usedBy.length}): ${usedBy.map(u => u.name).join(', ')}`
                : 'Not bound to any entity'}
            </Hint>
          </Row>
        )}
        {error && <Err role="alert">{error}</Err>}
        <Row>
          <Button onClick={save} disabled={create.isPending || update.isPending}>
            {isNew ? 'Create' : 'Save'}
          </Button>
          {!isNew && (
            <Button
              $bg="var(--s2-danger)"
              onClick={() => del.mutate({ id: aura.id })}
              disabled={del.isPending || usedBy.length > 0}
              title={usedBy.length > 0 ? 'Unbind it from these entities first' : undefined}
            >
              <HiOutlineTrash /> Delete
            </Button>
          )}
          {isNew && <Button $bg="var(--s2-btn-grey)" onClick={() => onDone && onDone()}>Cancel</Button>}
        </Row>
        {/* A rejected delete (409, stale data) arrives as a toast and here, so it is never swallowed. */}
        {del.isError && <Err role="alert">{del.error.message}</Err>}
      </Fields>
      <Preview form={form} />
    </Card>
  );
}

export default function AuraEffectsAdmin() {
  const { auras, isLoadingAuras } = useAuraEffectsAdmin();
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState('');
  const [sideFilter, setSideFilter] = useState('all');

  const filtered = auras.filter(a => {
    if (sideFilter !== 'all' && a.target_side !== sideFilter) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return (a.name && a.name.toLowerCase().includes(q)) || (a.shape && a.shape.toLowerCase().includes(q));
    }
    return true;
  });

  return (
    <AdminContainer>
      <Header>
        <h1 style={{ margin: 0 }}>Aura Effects</h1>
        <Button onClick={() => setAdding(true)} disabled={adding}>
          <HiOutlinePlus /> New aura
        </Button>
      </Header>
      <p style={{ color: 'var(--s2-text-muted)', marginTop: 0 }}>
        Auras are fields around an entity. Bind them in Entities → Auras. Renaming an aura updates every
        binding; deleting one that is still bound is refused.
      </p>
      <p style={{ color: 'var(--s2-text-muted)', marginTop: 0 }}>
        Edits apply to creatures on their next chunk load.
      </p>

      <Row style={{ marginBottom: '1.2rem', gap: '0.8rem' }}>
        <Input placeholder="Search auras..." $w="240px" value={search} onChange={e => setSearch(e.target.value)} />
        <Select value={sideFilter} onChange={e => setSideFilter(e.target.value)}>
          <option value="all">All Sides ({auras.length})</option>
          {AURA_SIDES.map(s => (
            <option key={s} value={s}>
              {s.toUpperCase()} ({auras.filter(a => a.target_side === s).length})
            </option>
          ))}
        </Select>
      </Row>

      {adding && <AuraCard aura={null} onDone={() => setAdding(false)} />}
      {isLoadingAuras && <AdminLoading label="Loading auras…" inline size={16} />}
      {filtered.map(a => <AuraCard key={a.id} aura={a} />)}
      {!isLoadingAuras && filtered.length === 0 && !adding && (
        <p style={{ color: 'var(--s2-text-muted)' }}>
          {auras.length > 0 ? 'No auras match your filter.' : 'No auras yet.'}
        </p>
      )}
    </AdminContainer>
  );
}
