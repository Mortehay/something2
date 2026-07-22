import { useState, useEffect } from 'react';
import styled from 'styled-components';
import toast from 'react-hot-toast';
import { HiOutlinePlus, HiOutlineTrash, HiOutlineArrowPath, HiOutlineSparkles, HiOutlineStar } from 'react-icons/hi2';
import { useWorlds, useCreateWorld, useDeleteWorld } from './useWorlds.js';
import { useEntityTypes } from './useMaps.js';
import { useUpdateWorld, useRegenerateWorld, useRerollCreatures, useWorldLinks, useSetLink, useClearLink, useWorldVillages, useAddVillage, useDeleteVillage } from './useMapsAdmin.js';

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
  background: #23233f; border: 1px solid ${p => p.$entry ? '#facc15' : '#333'};
  border-radius: 8px; padding: 1rem; margin-bottom: 1rem;
`;
const Row = styled.div`display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; margin: 0.4rem 0;`;
const Input = styled.input`background: #12121f; color: #eee; border: 1px solid #333; border-radius: 4px; padding: 0.4rem;`;
const CheckGrid = styled.div`display: flex; flex-wrap: wrap; gap: 0.75rem; margin: 0.4rem 0;`;

function bounded(w) { return !!(w.width && w.height); }

function MapCard({ world, creatureTypes, allMaps }) {
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

  useEffect(() => { setIsEntry(!!world.is_entry); }, [world.is_entry]);

  const toggle = (n) => setAllowed(prev => {
    const next = new Set(prev); next.has(n) ? next.delete(n) : next.add(n); return next;
  });
  const save = () => update.mutate({
    id: world.id, name, width: world.width, height: world.height,
    creature_count: Number(count), allowed_creature_types: [...allowed],
    is_entry: isEntry, entry_spawn: isEntry ? { x: Number(spawnX), y: Number(spawnY) } : null,
  });

  return (
    <Card $entry={world.is_entry}>
      <Row>
        <Input value={name} onChange={e => setName(e.target.value)} />
        <span style={{ color: '#888' }}>{world.width}×{world.height} tiles</span>
        {world.is_entry && <HiOutlineStar style={{ color: '#facc15' }} title="Player entry" />}
        <HiOutlineTrash style={{ color: '#ef4444', cursor: 'pointer', marginLeft: 'auto' }}
          onClick={() => window.confirm('Delete this map?') && del.mutate(world.id)} />
      </Row>
      <Row>
        <label style={{ color: '#aaa' }}>Creatures:</label>
        <Button $bg="#555" onClick={() => setCount(c => Math.max(0, Number(c) - 1))}>−</Button>
        <Input type="number" min="0" value={count} style={{ width: 70 }}
          onChange={e => setCount(e.target.value)} />
        <Button $bg="#555" onClick={() => setCount(c => Number(c) + 1)}>＋</Button>
      </Row>
      <CheckGrid>
        {creatureTypes.map(t => (
          <label key={t.id} style={{ color: '#ccc' }}>
            <input type="checkbox" checked={allowed.has(t.name)} onChange={() => toggle(t.name)} /> {t.name}
          </label>
        ))}
      </CheckGrid>
      <Row>
        <label style={{ color: '#aaa' }}>
          <input type="checkbox" checked={isEntry} onChange={e => setIsEntry(e.target.checked)} /> Player entry
        </label>
        {isEntry && (<>
          <span style={{ color: '#888' }}>spawn X</span>
          <Input type="number" value={spawnX} style={{ width: 90 }} onChange={e => setSpawnX(e.target.value)} />
          <span style={{ color: '#888' }}>Y</span>
          <Input type="number" value={spawnY} style={{ width: 90 }} onChange={e => setSpawnY(e.target.value)} />
        </>)}
      </Row>
      <Row>
        <Button onClick={save} disabled={update.isPending}>Save</Button>
        <Button $bg="#8b5cf6" onClick={() => regen.mutate(world.id)} disabled={regen.isPending}>
          <HiOutlineArrowPath /> Regenerate terrain
        </Button>
        <Button $bg="#10b981" onClick={() => reroll.mutate(world.id)} disabled={reroll.isPending}>
          <HiOutlineSparkles /> Re-roll creatures
        </Button>
      </Row>
      <Row>
        <span style={{ color: '#aaa' }}>Links:</span>
        {['N', 'E', 'S', 'W'].map(edge => (
          <label key={edge} style={{ color: '#ccc' }}>
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
        <span style={{ color: '#aaa' }}>Villages:</span>
        {villages.map((v) => (
          <div key={v.id} style={{ color: '#ccc', display: 'flex', gap: 8, alignItems: 'center' }}>
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
          <span style={{ color: '#888' }}>W</span>
          <Input type="number" min="8" max="4096" value={width} style={{ width: 80 }} onChange={e => setWidth(e.target.value)} />
          <span style={{ color: '#888' }}>H</span>
          <Input type="number" min="8" max="4096" value={height} style={{ width: 80 }} onChange={e => setHeight(e.target.value)} />
          <Button onClick={generate} disabled={createWorld.isPending}><HiOutlinePlus /> Generate map</Button>
        </Row>
      </Card>
      {boundedMaps.length === 0 && <p style={{ color: '#888' }}>No bounded maps yet. Generate one above.</p>}
      {boundedMaps.map(w => <MapCard key={w.id} world={w} creatureTypes={creatureTypes} allMaps={boundedMaps} />)}
    </AdminContainer>
  );
}

export default MapsAdmin;
