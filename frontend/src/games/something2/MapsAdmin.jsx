import { useState, useEffect, useMemo } from 'react';
import styled from 'styled-components';
import toast from 'react-hot-toast';
import { HiOutlinePlus, HiOutlineTrash, HiOutlineArrowPath, HiOutlineSparkles, HiOutlineStar, HiOutlineChevronRight, HiOutlineChevronDown } from 'react-icons/hi2';
import { useWorlds, useCreateWorld, useDeleteWorld } from './useWorlds.js';
import { useEntityTypes } from './useMaps.js';
import { useUpdateWorld, useRegenerateWorld, useRerollCreatures, useWorldLinks, useSetLink, useClearLink, useWorldVillages, useAddVillage, useDeleteVillage, useWorldsSummary } from './useMapsAdmin.js';
import { useBiomes } from './useBiomes.js';
import { orderBiomeNames } from './biomeForm.js';
import { groupWorldsByRegion, filterWorlds, defaultOpenGroups } from './mapListView.js';
import { matchCreatureTypes } from './creaturePicker.js';

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

// SOMET-554. A region's worlds sit inside a header that collapses, so an admin
// with 39 regions sees 39 lines rather than every world at once.
const GroupHeader = styled.div`
  display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none;
  color: var(--s2-text); font-weight: 600; padding: 0.45rem 0.6rem; margin-top: 0.6rem;
  background: var(--s2-surface-raised); border: 1px solid var(--s2-border); border-radius: 6px;
  &:hover { border-color: var(--s2-border-strong); }
`;
const SummaryRow = styled.div`
  display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; cursor: pointer;
  padding: 0.45rem 0.6rem; margin: 0.3rem 0 0.3rem 1.2rem;
  background: var(--s2-surface-raised);
  border: 1px solid ${p => p.$entry ? 'var(--s2-selected)' : 'var(--s2-border)'};
  border-radius: 6px;
  &:hover { border-color: var(--s2-border-strong); }
`;
const Chip = styled.span`
  font-size: 0.78em; padding: 1px 7px; border-radius: 10px;
  background: var(--s2-bg-sunken); color: var(--s2-text-secondary);
  border: 1px solid var(--s2-border);
`;
// Biomes and creature types both render as chips on the same row, and with one
// shared style "Highland Swarm / Highland Skirmisher / Highlands" reads as three
// creatures. A biome chip carries the biome's own catalog colour as a swatch so
// the two lists stay tellable apart at a glance -- which is the whole point of
// putting them on the collapsed row.
const BiomeChip = styled(Chip)`
  border-style: dashed; color: var(--s2-text-dim);
`;
const Swatch = styled.span`
  display: inline-block; width: 8px; height: 8px; border-radius: 2px;
  margin-right: 5px; vertical-align: middle; background: ${p => p.$color || 'var(--s2-border-strong)'};
`;
// The removable chip in the creature picker. `aria-label` lives on the button so
// the control is reachable without a DOM test being able to render it (see
// creaturePicker.js on why the logic, not the markup, carries the tests).
const RemoveChip = styled.button`
  font-size: 0.78em; padding: 1px 7px 1px 9px; border-radius: 10px; cursor: pointer;
  background: var(--s2-bg-sunken); color: var(--s2-text); border: 1px solid var(--s2-border-strong);
  display: inline-flex; align-items: center; gap: 5px;
  &:hover { border-color: var(--s2-danger); }
`;
const Muted = styled.span`color: var(--s2-text-dim); font-size: 0.85em;`;
// Results drop below the search box; capped height so a two-letter query that
// matches 80 types cannot push the rest of the card off screen.
const PickerResults = styled.div`
  display: flex; flex-wrap: wrap; gap: 0.4rem; max-height: 170px; overflow-y: auto;
  padding: 0.5rem; margin: 0.3rem 0; background: var(--s2-bg-sunken);
  border: 1px solid var(--s2-border); border-radius: 6px;
`;
const PickerOption = styled.button`
  font-size: 0.8em; padding: 2px 8px; border-radius: 10px; cursor: pointer;
  background: var(--s2-surface-raised); color: var(--s2-text-secondary); border: 1px solid var(--s2-border);
  &:hover { color: var(--s2-text); border-color: var(--s2-accent); }
`;

function bounded(w) { return !!(w.width && w.height); }

// SOMET-554. Replaces a grid of one checkbox per creature type. On the dev
// database that grid was 293 checkboxes per card to express a selection that is
// never larger than 6 -- every bounded world allows between 1 and 6 types. The
// selection renders as chips (so it stays readable at a glance) and the long
// tail is reached by searching rather than by scrolling past 287 unchecked boxes.
function CreaturePicker({ creatureTypes, allowed, onAdd, onRemove }) {
  const [query, setQuery] = useState('');
  const matches = useMemo(
    () => matchCreatureTypes(creatureTypes, query, { exclude: allowed }),
    [creatureTypes, query, allowed],
  );

  return (
    <>
      <Row>
        <label style={{ color: 'var(--s2-text-muted)' }}>Creature types:</label>
        {allowed.size === 0 && <Muted>none — this map will scatter no creatures</Muted>}
        {[...allowed].map((n) => (
          <RemoveChip key={n} type="button" aria-label={`Remove ${n}`} onClick={() => onRemove(n)}>
            {n} <span aria-hidden="true">×</span>
          </RemoveChip>
        ))}
      </Row>
      <Row>
        <Input
          placeholder={`Search ${(creatureTypes || []).length} creature types…`}
          value={query} style={{ width: 260 }}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query.trim() !== '' && (
          <Muted>
            {matches.total === 0
              ? 'no match'
              : `${matches.shown.length} of ${matches.total} shown`}
          </Muted>
        )}
      </Row>
      {query.trim() !== '' && matches.shown.length > 0 && (
        <PickerResults>
          {matches.shown.map((t) => (
            <PickerOption key={t.id ?? t.name} type="button" onClick={() => { onAdd(t.name); }}>
              + {t.name}
            </PickerOption>
          ))}
        </PickerResults>
      )}
    </>
  );
}

// SOMET-554. The always-rendered half of a map. Everything here reads off
// /api/worlds plus the batched /api/worlds/summary, so a hundred of these cost
// a hundred rows and zero extra requests -- the per-world links/villages queries
// live in the expanded body below and only run for the one card that is open.
function MapRow({ world, summary, biomeColors = {}, open, onToggle, onDelete }) {
  const allowed = world.allowed_creature_types || [];
  const worldBiomes = world.biomes || [];
  const portals = summary?.portal_count ?? 0;
  const villages = summary?.village_count ?? 0;

  return (
    <SummaryRow $entry={world.is_entry} onClick={onToggle}>
      {open ? <HiOutlineChevronDown /> : <HiOutlineChevronRight />}
      <b>{world.name}</b>
      <Muted>{world.width}×{world.height}</Muted>
      {world.is_entry && <HiOutlineStar style={{ color: 'var(--s2-selected)' }} title="Player entry" />}
      {/* summary is undefined until /api/worlds/summary resolves; render nothing
          rather than a confident "No Dungeon" that may flip a moment later. */}
      {summary && (portals > 0
        ? <Chip style={{ color: 'var(--s2-tab-items)', borderColor: 'var(--s2-tab-items)' }}>
            🏰 {portals} portal{portals > 1 ? 's' : ''}
          </Chip>
        : <Chip>🌿 no dungeon</Chip>)}
      {summary && villages > 0 && <Chip>🏘 {villages} village{villages > 1 ? 's' : ''}</Chip>}
      <Muted>{world.creature_count ?? 0} creatures</Muted>
      {allowed.map((n) => <Chip key={n}>{n}</Chip>)}
      {worldBiomes.map((n) => (
        <BiomeChip key={`b-${n}`} title={`Biome: ${n}`}>
          <Swatch $color={biomeColors[n]} />{n}
        </BiomeChip>
      ))}
      <HiOutlineTrash
        style={{ color: 'var(--s2-danger)', cursor: 'pointer', marginLeft: 'auto' }}
        title="Delete this map"
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
      />
    </SummaryRow>
  );
}

function MapCard({ world, creatureTypes, allMaps, biomes, biomesLoading }) {
  const update = useUpdateWorld();
  const regen = useRegenerateWorld();
  const reroll = useRerollCreatures();
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
  // NOT state, and NOT editable. worlds.creature_count is derived: every
  // population pass (seeding and the Re-roll button both go through
  // populateWorld) overwrites it with how many creatures were actually
  // scattered, from the world's `density` tier. It used to be an editable
  // number input that PUT a value nothing read, so setting it to 5 and
  // re-rolling produced 15 creatures and then jumped the field to 12
  // (SOMET-246). Read straight off the prop so it always shows what is
  // persisted rather than a stale first-render copy.
  const creatureCount = world.creature_count ?? 0;
  // SOMET-554: this card now mounts when its row is expanded and unmounts when
  // it is collapsed, so these snapshots are taken fresh each time the form is
  // opened. That is deliberately NOT the same as syncing them from props on
  // every render -- Re-roll and Regenerate both invalidate ["worlds"], and
  // re-seeding the form on that would throw away whatever the admin had just
  // typed. The one existing sync below is is_entry, which is a special case:
  // setting a different map as entry clears this one's flag server-side, so the
  // checkbox has to follow a change this card did not make.
  const [allowed, setAllowed] = useState(new Set(world.allowed_creature_types || []));
  const [isEntry, setIsEntry] = useState(!!world.is_entry);
  const cx = world.width ? Math.floor((world.width * 100) / 2) : 0;
  const cy = world.height ? Math.floor((world.height * 100) / 2) : 0;
  const [spawnX, setSpawnX] = useState(world.entry_spawn?.x ?? cx);
  const [spawnY, setSpawnY] = useState(world.entry_spawn?.y ?? cy);
  const [worldBiomes, setWorldBiomes] = useState(new Set(world.biomes || []));
  const [biomeCell, setBiomeCell] = useState(world.biome_cell ?? '');

  useEffect(() => { setIsEntry(!!world.is_entry); }, [world.is_entry]);

  const addAllowed = (n) => setAllowed(prev => new Set(prev).add(n));
  const removeAllowed = (n) => setAllowed(prev => {
    const next = new Set(prev); next.delete(n); return next;
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
      // Echoed back unchanged, never edited here: PUT /api/worlds/:id treats a
      // missing creature_count as 0, so omitting it would zero the derived
      // column on every unrelated save (renaming the map, toggling entry).
      creature_count: creatureCount, allowed_creature_types: [...allowed],
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

  const portalLinks = (links || []).filter(l => l.edge === 'PORTAL');
  const hasDungeon = portalLinks.length > 0;

  return (
    <Card $entry={world.is_entry} style={{ marginLeft: '1.2rem' }}>
      <Row>
        <label style={{ color: 'var(--s2-text-muted)' }}>Name:</label>
        <Input value={name} onChange={e => setName(e.target.value)} />
        <span style={{ color: 'var(--s2-text-dim)' }}>{world.width}×{world.height} tiles</span>
        {hasDungeon ? (
          <span style={{ color: 'var(--s2-tab-items)', fontWeight: 600, fontSize: '0.85em', background: 'var(--s2-surface-raised)', border: '1px solid var(--s2-tab-items)', padding: '2px 8px', borderRadius: '4px' }}>
            🏰 Dungeon: Yes ({portalLinks.length} portal{portalLinks.length > 1 ? 's' : ''})
          </span>
        ) : (
          <span style={{ color: 'var(--s2-text-dim)', fontSize: '0.85em', background: 'var(--s2-surface-raised)', padding: '2px 8px', borderRadius: '4px' }}>
            🌿 No Dungeon
          </span>
        )}
      </Row>
      <Row>
        <label style={{ color: 'var(--s2-text-muted)' }}>Creatures scattered:</label>
        {/* Dimmed explicitly: the styled Input pins `color`, so the browser's
            default disabled greying never lands and the field would otherwise
            still read as editable. */}
        <Input type="number" value={creatureCount} readOnly disabled
          style={{ width: 70, color: 'var(--s2-text-dim)' }}
          title="Derived from this map's density tier — not editable here" />
        <span style={{ color: 'var(--s2-text-dim)', fontSize: '0.85em' }}>
          reported, not set — the count comes from this map's density tier. Use Re-roll creatures below,
          or change the tier in the map spec and re-seed.
        </span>
      </Row>
      <CreaturePicker
        creatureTypes={creatureTypes} allowed={allowed}
        onAdd={addAllowed} onRemove={removeAllowed}
      />
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
  const summaryByWorld = useWorldsSummary();
  const createWorld = useCreateWorld();
  const del = useDeleteWorld();
  const [name, setName] = useState('');
  const [width, setWidth] = useState(24);
  const [height, setHeight] = useState(24);
  const [query, setQuery] = useState('');
  // Which single map card is expanded. One at a time on purpose: it is what
  // keeps the tab's cost flat as regions keep being added, since the expanded
  // body is the only thing that builds the four ~100-option link selects and
  // fires the per-world links/villages queries.
  const [openId, setOpenId] = useState(null);
  // null means "follow the defaults for the current filter state". A click on a
  // group header replaces it with an explicit set; typing in the filter puts it
  // back to null so newly matching groups open themselves.
  const [openGroups, setOpenGroups] = useState(null);

  const creatureTypes = useMemo(
    () => (entityTypes || []).filter(t => t.is_creature),
    [entityTypes],
  );
  const boundedMaps = useMemo(() => (worlds || []).filter(bounded), [worlds]);
  const biomeColors = useMemo(() => {
    const by = {};
    for (const b of biomes || []) by[b.name] = b.color;
    return by;
  }, [biomes]);
  const filtering = query.trim() !== '';
  const visible = useMemo(() => filterWorlds(boundedMaps, query), [boundedMaps, query]);
  const groups = useMemo(() => groupWorldsByRegion(visible), [visible]);

  useEffect(() => { setOpenGroups(null); }, [query]);

  const effectiveOpenGroups = openGroups ?? defaultOpenGroups(groups, { filtered: filtering });
  const toggleGroup = (region) => setOpenGroups(() => {
    const next = new Set(effectiveOpenGroups);
    next.has(region) ? next.delete(region) : next.add(region);
    return next;
  });

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
      <Row>
        <Input placeholder="Filter maps by name…" value={query} style={{ width: 280 }}
          onChange={e => setQuery(e.target.value)} />
        <Muted>
          {filtering
            ? `${visible.length} of ${boundedMaps.length} maps`
            : `${boundedMaps.length} maps in ${groups.length} groups`}
        </Muted>
      </Row>
      {boundedMaps.length === 0 && <p style={{ color: 'var(--s2-text-dim)' }}>No bounded maps yet. Generate one above.</p>}
      {boundedMaps.length > 0 && visible.length === 0 && (
        <p style={{ color: 'var(--s2-text-dim)' }}>No map matches “{query.trim()}”.</p>
      )}
      {groups.map(g => {
        const groupOpen = effectiveOpenGroups.has(g.region);
        return (
          <div key={g.region}>
            <GroupHeader onClick={() => toggleGroup(g.region)}>
              {groupOpen ? <HiOutlineChevronDown /> : <HiOutlineChevronRight />}
              {g.region}
              <Muted>{g.worlds.length} map{g.worlds.length > 1 ? 's' : ''}</Muted>
            </GroupHeader>
            {groupOpen && g.worlds.map(w => (
              <div key={w.id}>
                <MapRow
                  world={w} summary={summaryByWorld[w.id]} biomeColors={biomeColors}
                  open={openId === w.id}
                  onToggle={() => setOpenId(prev => (prev === w.id ? null : w.id))}
                  onDelete={() => window.confirm('Delete this map?') && del.mutate(w.id)}
                />
                {openId === w.id && (
                  <MapCard world={w} creatureTypes={creatureTypes} allMaps={boundedMaps}
                    biomes={biomes} biomesLoading={isLoadingBiomes} />
                )}
              </div>
            ))}
          </div>
        );
      })}
    </AdminContainer>
  );
}

export default MapsAdmin;
