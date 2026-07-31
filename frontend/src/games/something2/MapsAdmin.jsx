import { useState, useEffect } from 'react';
import styled from 'styled-components';
import toast from 'react-hot-toast';
import { HiOutlinePlus, HiOutlineTrash, HiOutlineArrowPath, HiOutlineSparkles, HiOutlineStar } from 'react-icons/hi2';
import { useWorlds, useCreateWorld, useDeleteWorld } from './useWorlds.js';
import { useEntityTypes } from './useMaps.js';
import { useUpdateWorld, useRegenerateWorld, useRerollCreatures, useWorldLinks, useSetLink, useClearLink, useWorldVillages, useAddVillage, useDeleteVillage } from './useMapsAdmin.js';
import { useBiomes } from './useBiomes.js';
import { orderBiomeNames } from './biomeForm.js';

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
  background: var(--s2-surface-raised); border: 1px solid ${p => p.$entry ? 'var(--s2-selected)' : 'var(--s2-border)'};
  border-radius: 8px; padding: 1rem; margin-bottom: 1rem;
`;
const Row = styled.div`display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; margin: 0.4rem 0;`;
const Input = styled.input`background: var(--s2-bg-sunken); color: var(--s2-text); border: 1px solid var(--s2-border-strong); border-radius: 4px; padding: 0.4rem;`;
const CheckGrid = styled.div`display: flex; flex-wrap: wrap; gap: 0.75rem; margin: 0.4rem 0;`;

function bounded(w) { return !!(w.width && w.height); }

function MapCard({ world, creatureTypes, allMaps, biomes, biomesLoading }) {
  const update = useUpdateWorld();
  const regen = useRegenerateWorld();
  const reroll = useRerollCreatures();
  const del = useDeleteWorld();
  const links = useWorldLinks(world.id);
  const setLink = useSetLink();
  const clearLink = useClearLink();
  const villages = useWorldVillages(world.id);
  const addVillage = useAddVillage();
  const delVillage = useDeleteVillage();
  const [vMinRow, setVMinRow] = useState(1);
  const [vMinCol, setVMinCol] = useState(1);
  const [vW, setVW] = useState(6);
  const [vH, setVH] = useState(5);
  const [vGate, setVGate] = useState('S');
  const others = (allMaps || []).filter(m => m.id !== world.id);
  const linkFor = (edge) => links.find(l => l.edge === edge)?.to_world_id || '';
  const [name, setName] = useState(world.name);
  const [count, setCount] = useState(world.creature_count ?? 0);
  const [allowed, setAllowed] = useState(new Set(world.allowed_creature_types || []));
  const [isEntry, setIsEntry] = useState(!!world.is_entry);
  const cx = world.width ? Math.floor((world.width * 100) / 2) : 0;
  const cy = world.height ? Math.floor((world.height * 100) / 2) : 0;
  const [spawnX, setSpawnX] = useState(world.entry_spawn?.x ?? cx);
  const [spawnY, setSpawnY] = useState(world.entry_spawn?.y ?? cy);
  const [worldBiomes, setWorldBiomes] = useState(new Set(world.biomes || []));
  const [biomeCell, setBiomeCell] = useState(world.biome_cell ?? '');

  useEffect(() => { setIsEntry(!!world.is_entry); }, [world.is_entry]);

  const toggle = (n) => setAllowed(prev => {
    const next = new Set(prev); next.has(n) ? next.delete(n) : next.add(n); return next;
  });
  const toggleBiome = (n) => setWorldBiomes(prev => {
    const next = new Set(prev); next.has(n) ? next.delete(n) : next.add(n); return next;
  });
  // Belt-and-braces alongside orderBiomeNames' own empty-catalog fallback:
  // block the save outright while the biome catalog is still loading, so a
  // save triggered by an unrelated field (e.g. renaming the map) can never
  // fire against a `biomes` prop that is [] only because the query hasn't
  // resolved yet -- not because the world actually has zero biomes selected.
  const save = () => {
    if (biomesLoading) return;
    update.mutate({
      id: world.id, name, width: world.width, height: world.height,
      creature_count: Number(count), allowed_creature_types: [...allowed],
      is_entry: isEntry, entry_spawn: isEntry ? { x: Number(spawnX), y: Number(spawnY) } : null,
      // Ordered by the biome CATALOG's own order (id ASC), not by checkbox
      // click order -- worlds.biomes is order-sensitive on the backend (biome
      // i owns noise band i), so a Set's click-order iteration would make an
      // uncheck+recheck of the SAME biomes look like a real change and wipe
      // this world's cached terrain for no visible reason. See biomeForm.js.
      biomes: orderBiomeNames(worldBiomes, biomes),
      biome_cell: biomeCell === '' ? null : Number(biomeCell),
    });
  };

  return (
    <Card $entry={world.is_entry}>
      <Row>
        <Input value={name} onChange={e => setName(e.target.value)} />
        <span style={{ color: 'var(--s2-text-dim)' }}>{world.width}×{world.height} tiles</span>
        {world.is_entry && <HiOutlineStar style={{ color: 'var(--s2-selected)' }} title="Player entry" />}
        <HiOutlineTrash style={{ color: 'var(--s2-danger)', cursor: 'pointer', marginLeft: 'auto' }}
          onClick={() => window.confirm('Delete this map?') && del.mutate(world.id)} />
      </Row>
      <Row>
        <label style={{ color: 'var(--s2-text-muted)' }}>Creatures:</label>
        <Button $bg="var(--s2-btn-neutral)" onClick={() => setCount(c => Math.max(0, Number(c) - 1))}>−</Button>
        <Input type="number" min="0" value={count} style={{ width: 70 }}
          onChange={e => setCount(e.target.value)} />
        <Button $bg="var(--s2-btn-neutral)" onClick={() => setCount(c => Number(c) + 1)}>＋</Button>
      </Row>
      <CheckGrid>
        {creatureTypes.map(t => (
          <label key={t.id} style={{ color: 'var(--s2-text-secondary)' }}>
            <input type="checkbox" checked={allowed.has(t.name)} onChange={() => toggle(t.name)} /> {t.name}
          </label>
        ))}
      </CheckGrid>
      <Row>
        <label style={{ color: 'var(--s2-text-muted)' }}>
          <input type="checkbox" checked={isEntry} onChange={e => setIsEntry(e.target.checked)} /> Player entry
        </label>
        {isEntry && (<>
          <span style={{ color: 'var(--s2-text-dim)' }}>spawn X</span>
          <Input type="number" value={spawnX} style={{ width: 90 }} onChange={e => setSpawnX(e.target.value)} />
          <span style={{ color: 'var(--s2-text-dim)' }}>Y</span>
          <Input type="number" value={spawnY} style={{ width: 90 }} onChange={e => setSpawnY(e.target.value)} />
        </>)}
      </Row>
      <Row>
        <Button onClick={save} disabled={update.isPending || biomesLoading}
          title={biomesLoading ? 'Waiting for the biome catalog to load…' : undefined}>Save</Button>
        <Button $bg="var(--s2-btn-purple)" onClick={() => regen.mutate(world.id)} disabled={regen.isPending}>
          <HiOutlineArrowPath /> Regenerate terrain
        </Button>
        <Button $bg="var(--s2-success-alt)" onClick={() => reroll.mutate(world.id)} disabled={reroll.isPending}>
          <HiOutlineSparkles /> Re-roll creatures
        </Button>
      </Row>
      <Row>
        <span style={{ color: 'var(--s2-text-muted)' }}>Biomes:</span>
        {(biomes || []).map(b => (
          <label key={b.id} style={{ color: 'var(--s2-text-secondary)' }}>
            <input type="checkbox" checked={worldBiomes.has(b.name)} onChange={() => toggleBiome(b.name)} />
            <span style={{ display: 'inline-block', width: 10, height: 10, background: b.color, marginLeft: 4, marginRight: 3 }} />
            {b.name}
          </label>
        ))}
        <span style={{ color: 'var(--s2-text-dim)' }}>region size</span>
        <Input type="number" min="8" placeholder="auto" value={biomeCell} style={{ width: 80 }}
          onChange={e => setBiomeCell(e.target.value)} />
      </Row>
      <Row>
        <span style={{ color: 'var(--s2-warning)', fontSize: '0.85em' }}>
          Changing biomes or region size regenerates this map's terrain and clears its cached chunks.
          Regions are assigned to biomes in the order the biomes are listed above (catalog order — not click order).
        </span>
      </Row>
      <Row>
        <span style={{ color: 'var(--s2-text-muted)' }}>Links:</span>
        {['N', 'E', 'S', 'W'].map(edge => (
          <label key={edge} style={{ color: 'var(--s2-text-secondary)' }}>
            {edge}{' '}
            <select value={linkFor(edge)} onChange={e => {
              const to = e.target.value;
              if (to) setLink.mutate({ id: world.id, edge, to_world_id: to });
              else clearLink.mutate({ id: world.id, edge });
            }}>
              <option value="">—</option>
              {others.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
        ))}
      </Row>
      <Row style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
        <span style={{ color: 'var(--s2-text-muted)' }}>Villages:</span>
        {villages.map((v) => (
          <div key={v.id} style={{ color: 'var(--s2-text-secondary)', display: 'flex', gap: 8, alignItems: 'center' }}>
            <span>({v.min_row},{v.min_col}) {v.width}×{v.height} gate {v.gate_edge}</span>
            <button onClick={() => delVillage.mutate({ id: world.id, villageId: v.id })}>Delete</button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          row <Input type="number" value={vMinRow} onChange={(e) => setVMinRow(+e.target.value)} style={{ width: 52 }} />
          col <Input type="number" value={vMinCol} onChange={(e) => setVMinCol(+e.target.value)} style={{ width: 52 }} />
          w <Input type="number" min={3} max={8} value={vW} onChange={(e) => setVW(+e.target.value)} style={{ width: 44 }} />
          h <Input type="number" min={3} max={6} value={vH} onChange={(e) => setVH(+e.target.value)} style={{ width: 44 }} />
          gate <select value={vGate} onChange={(e) => setVGate(e.target.value)}>
            {['N', 'E', 'S', 'W'].map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
          <Button onClick={() => addVillage.mutate({
            id: world.id, min_row: vMinRow, min_col: vMinCol, width: vW, height: vH, gate_edge: vGate,
            spawn_x: (vMinCol + vW / 2) * 100, spawn_y: (vMinRow + vH / 2) * 100,
          })} disabled={addVillage.isPending}>Add village</Button>
        </div>
      </Row>
    </Card>
  );
}

function MapsAdmin() {
  const { worlds, isLoadingWorlds } = useWorlds();
  const { entityTypes } = useEntityTypes();
  const { biomes, isLoadingBiomes } = useBiomes();
  const createWorld = useCreateWorld();
  const [name, setName] = useState('');
  const [width, setWidth] = useState(24);
  const [height, setHeight] = useState(24);

  const creatureTypes = (entityTypes || []).filter(t => t.is_creature);
  const boundedMaps = (worlds || []).filter(bounded);

  const generate = () => {
    if (!name.trim()) return toast.error('Name is required');
    createWorld.mutate({ name: name.trim(), width: Number(width), height: Number(height) },
      { onSuccess: () => setName('') });
  };

  if (isLoadingWorlds) return <AdminContainer>Loading maps…</AdminContainer>;

  return (
    <AdminContainer>
      <Header><h2>Maps</h2></Header>
      <Card>
        <Row>
          <Input placeholder="New map name" value={name} onChange={e => setName(e.target.value)} />
          <span style={{ color: 'var(--s2-text-dim)' }}>W</span>
          <Input type="number" min="8" max="4096" value={width} style={{ width: 80 }} onChange={e => setWidth(e.target.value)} />
          <span style={{ color: 'var(--s2-text-dim)' }}>H</span>
          <Input type="number" min="8" max="4096" value={height} style={{ width: 80 }} onChange={e => setHeight(e.target.value)} />
          <Button onClick={generate} disabled={createWorld.isPending}><HiOutlinePlus /> Generate map</Button>
        </Row>
      </Card>
      {boundedMaps.length === 0 && <p style={{ color: 'var(--s2-text-dim)' }}>No bounded maps yet. Generate one above.</p>}
      {boundedMaps.map(w => <MapCard key={w.id} world={w} creatureTypes={creatureTypes} allMaps={boundedMaps} biomes={biomes} biomesLoading={isLoadingBiomes} />)}
    </AdminContainer>
  );
}

export default MapsAdmin;
