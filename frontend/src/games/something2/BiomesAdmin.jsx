import { useState } from 'react';
import styled from 'styled-components';
import { HiOutlinePlus, HiOutlineTrash } from 'react-icons/hi2';
import { useTileTypes, useEntityTypes } from './useMaps.js';
import { useBiomes, useCreateBiome, useUpdateBiome, useDeleteBiome } from './useBiomes.js';
import { emptyBiomeForm, biomeToForm, biomeFormToPayload } from './biomeForm.js';

const AdminContainer = styled.div`
  padding: 2rem; color: #eee; max-width: 1200px; margin: 0 auto;
  height: 100%; overflow-y: auto; background-color: #1a1a2e;
`;
const Header = styled.div`display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;`;
const Button = styled.button`
  background: ${p => p.$bg || '#4a9eff'}; color: white; border: none; border-radius: 6px;
  padding: 0.5rem 1rem; font-weight: bold; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
  &:disabled { opacity: 0.5; cursor: default; }
`;
const Card = styled.div`
  background: #23233f; border: 1px solid #333; border-radius: 8px; padding: 1rem; margin-bottom: 1rem;
`;
const Row = styled.div`display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; margin: 0.4rem 0;`;
const Input = styled.input`background: #12121f; color: #eee; border: 1px solid #333; border-radius: 4px; padding: 0.4rem;`;
const CheckGrid = styled.div`display: flex; flex-wrap: wrap; gap: 0.75rem; margin: 0.4rem 0;`;
const Label = styled.span`color: #aaa; min-width: 90px;`;

const Swatch = styled.span`
  display: inline-block; width: 14px; height: 14px; border-radius: 3px;
  border: 1px solid #555; background: ${p => p.$color};
`;

// One checkbox row bound to a string-array field of the form.
function NameChecks({ options, selected, onToggle }) {
  return (
    <CheckGrid>
      {options.map(name => (
        <label key={name} style={{ color: '#ccc' }}>
          <input type="checkbox" checked={selected.includes(name)} onChange={() => onToggle(name)} /> {name}
        </label>
      ))}
    </CheckGrid>
  );
}

function BiomeCard({ biome, tileNames, floraNames, creatureNames }) {
  const [form, setForm] = useState(() => (biome ? biomeToForm(biome) : emptyBiomeForm()));
  const create = useCreateBiome();
  const update = useUpdateBiome();
  const del = useDeleteBiome();
  const isNew = !biome;

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const toggle = (k) => (name) => setForm(f => ({
    ...f,
    [k]: f[k].includes(name) ? f[k].filter(n => n !== name) : [...f[k], name],
  }));

  const save = () => {
    const payload = biomeFormToPayload(form);
    if (isNew) create.mutate(payload, { onSuccess: () => setForm(emptyBiomeForm()) });
    else update.mutate({ id: biome.id, body: payload });
  };

  return (
    <Card>
      <Row>
        <Swatch $color={form.color} />
        <Input placeholder="Biome name" value={form.name} onChange={e => set('name', e.target.value)} />
        <input type="color" value={form.color} onChange={e => set('color', e.target.value)}
          title="Display colour (admin lists and map markers)" />
        {!isNew && (
          <HiOutlineTrash style={{ color: '#ef4444', cursor: 'pointer', marginLeft: 'auto' }}
            title="Delete biome"
            onClick={() => window.confirm(`Delete biome "${biome.name}"?`) && del.mutate({ id: biome.id })} />
        )}
      </Row>

      <Row><Label>Terrain</Label></Row>
      <NameChecks options={tileNames} selected={form.terrain_tiles} onToggle={toggle('terrain_tiles')} />

      <Row><Label>Flora</Label></Row>
      <NameChecks options={floraNames} selected={form.flora_types} onToggle={toggle('flora_types')} />

      <Row><Label>Creatures</Label></Row>
      <NameChecks options={creatureNames} selected={form.creature_types} onToggle={toggle('creature_types')} />

      <Row>
        <Label>Palette</Label>
        <Input style={{ flex: 1, minWidth: 260 }} placeholder="ochre, gold, burnt sienna"
          value={form.palette} onChange={e => set('palette', e.target.value)} />
      </Row>
      <Row>
        <Label>Art style</Label>
        <Input style={{ flex: 1, minWidth: 260 }} placeholder="sun-bleached hand-drawn fantasy, harsh light"
          value={form.art_style} onChange={e => set('art_style', e.target.value)} />
      </Row>
      <Row>
        <Label>Exclusions</Label>
        <Input style={{ flex: 1, minWidth: 260 }} placeholder="no grass, no snow"
          value={form.exclusions} onChange={e => set('exclusions', e.target.value)} />
      </Row>
      <Row>
        <Button onClick={save} disabled={create.isPending || update.isPending}>
          {isNew ? <><HiOutlinePlus /> Create biome</> : 'Save'}
        </Button>
        <span style={{ color: '#888', fontSize: '0.85em' }}>
          Palette, art style and exclusions are composed into image-generation prompts.
        </span>
      </Row>
    </Card>
  );
}

function BiomesAdmin() {
  const { biomes, isLoadingBiomes } = useBiomes();
  const { tileTypes } = useTileTypes();
  const { entityTypes } = useEntityTypes();

  const tileNames = (tileTypes || []).map(t => t.name);
  const floraNames = (entityTypes || []).filter(e => !e.is_creature).map(e => e.name);
  const creatureNames = (entityTypes || []).filter(e => e.is_creature).map(e => e.name);
  const lists = { tileNames, floraNames, creatureNames };

  if (isLoadingBiomes) return <AdminContainer>Loading biomes…</AdminContainer>;

  return (
    <AdminContainer>
      <Header><h2>Biomes</h2></Header>
      <BiomeCard biome={null} {...lists} />
      {biomes.length === 0 && <p style={{ color: '#888' }}>No biomes yet. Create one above.</p>}
      {biomes.map(b => <BiomeCard key={b.id} biome={b} {...lists} />)}
    </AdminContainer>
  );
}

export default BiomesAdmin;
