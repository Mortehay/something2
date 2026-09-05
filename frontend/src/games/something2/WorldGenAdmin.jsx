import { useState } from 'react';
import styled from 'styled-components';
import {
  HiOutlineArrowPath, HiOutlineArrowDownTray, HiOutlineTrash,
  HiOutlineSparkles, HiOutlineExclamationTriangle,
} from 'react-icons/hi2';
import {
  useGeneratedWorlds, useRegionSpec, useRegionPreview, useRegionReport,
  useCreateRegion, useEditRegion, useDeleteRegion, useDownloadRegion, useSeedRegion,
} from './useWorldGen.js';
import { ACHIEVABLE, nearestAchievable, isMisleading } from './densityTargets.js';

const AdminContainer = styled.div`
  padding: 2rem; color: var(--s2-text); max-width: 1200px; margin: 0 auto;
  height: 100%; overflow-y: auto; background-color: var(--s2-surface);
`;
const Header = styled.div`display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;`;
const Sub = styled.p`color: var(--s2-text-muted); margin: 0 0 1.5rem; font-size: 0.9rem;`;
const Button = styled.button`
  background: ${p => p.$bg || 'var(--s2-accent)'}; color: var(--s2-on-accent); border: none; border-radius: 6px;
  padding: 0.5rem 1rem; font-weight: bold; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
  &:disabled { opacity: 0.5; cursor: default; }
`;
const Card = styled.div`
  background: var(--s2-surface-raised); border: 1px solid ${p => (p.$selected ? 'var(--s2-accent)' : 'var(--s2-border)')};
  border-radius: 8px; padding: 1rem; margin-bottom: 1rem;
`;
const Row = styled.div`display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; margin: 0.4rem 0;`;
const Input = styled.input`
  background: var(--s2-bg-sunken); color: var(--s2-text); border: 1px solid var(--s2-border-strong);
  border-radius: 4px; padding: 0.4rem;
`;
const Label = styled.span`color: var(--s2-text-muted); min-width: 130px;`;
const Stat = styled.span`color: var(--s2-text-secondary); font-size: 0.9rem;`;
const Badge = styled.span`
  background: ${p => p.$bg || 'var(--s2-border)'}; color: var(--s2-on-accent);
  border-radius: 999px; padding: 0.1rem 0.6rem; font-size: 0.75rem; font-weight: bold;
`;
// An error the person has to be able to READ. The whole reason this component
// keeps a distinct error state instead of rendering an empty list: an auth
// failure and an unreachable generator otherwise look exactly like "nothing
// has been generated yet", which is the bug that shipped on the generator's
// own side and took a while to spot.
const ErrorBanner = styled.div`
  background: var(--s2-bg-sunken); border: 1px solid var(--s2-danger, #b4423a); border-left-width: 4px;
  border-radius: 6px; padding: 0.9rem 1rem; margin-bottom: 1rem; color: var(--s2-text);
  display: flex; gap: 0.6rem; align-items: flex-start;
`;
const Mono = styled.pre`
  background: var(--s2-bg-sunken); border: 1px solid var(--s2-border); border-radius: 6px;
  padding: 0.6rem 0.8rem; overflow-x: auto; font-size: 0.8rem; color: var(--s2-text-secondary); margin: 0.5rem 0 0;
`;
const PreviewImg = styled.img`
  max-width: 100%; image-rendering: pixelated; border: 1px solid var(--s2-border); border-radius: 6px;
`;

const num = (v, fallback) => (Number.isFinite(Number(v)) && String(v).trim() !== '' ? Number(v) : fallback);

// What the number in the box will ACTUALLY produce.
//
// `target_per_screen` looks like a dial and is a five-position switch: the
// generator picks a density tier, and the achievable per-screen values are
// 2.0 / 4.1 / 8.1 / 14.0 / 20.0. A request of 6 silently becomes 4.1. Offering
// a free number with no feedback is offering a continuous control over a
// discrete one, and the person reading "6" afterwards will reasonably believe
// they got about 6.
//
// So the achieved value is shown beside the requested one always, and the gap
// is called out when it exceeds the same 15% the generator itself warns at.
function AchievedNote({ requested }) {
  const hit = nearestAchievable(requested);
  if (!hit) return null;
  const off = isMisleading(requested);
  const pct = Math.round(hit.missesBy * 100);
  return (
    <Stat style={off ? { color: 'var(--s2-danger, #b4423a)' } : undefined}>
      → produces <strong>{hit.perScreen}</strong>/screen ({hit.tier})
      {off && ` — ${hit.shortfall < 0 ? 'short of' : 'over'} the ${hit.requested} you asked for by ${pct}%`}
    </Stat>
  );
}

// The values that cost nothing to ask for. Clicking one is the difference
// between a control that rounds silently and one that says what it can do.
function AchievablePicks({ onPick }) {
  return (
    <Row>
      <Label>Achievable</Label>
      {ACHIEVABLE.map(t => (
        <Button key={t.tier} $bg="var(--s2-border)" onClick={() => onPick(t.perScreen)}>
          {t.perScreen} <span style={{ opacity: 0.7 }}>({t.tier})</span>
        </Button>
      ))}
    </Row>
  );
}

// One screenful per cell is what the generator draws, so the dots in the
// preview ARE the per-screen count -- which is why this is shown before the
// download button rather than after it.
function PreviewPanel({ name, version }) {
  const { previewUrl, previewError, isLoadingPreview } = useRegionPreview(name, version);
  if (isLoadingPreview) return <Stat>Loading preview…</Stat>;
  if (previewError) {
    return (
      <ErrorBanner>
        <HiOutlineExclamationTriangle size={20} />
        <div><strong>Preview unavailable.</strong><div>{previewError.message}</div></div>
      </ErrorBanner>
    );
  }
  if (!previewUrl) return null;
  return <PreviewImg src={previewUrl} alt={`Preview of ${name}, one cell per screenful`} />;
}

// The generator's own problems and caveats.
//
// It computes these and, until now, nothing in this UI read them -- so a
// warning it raised deliberately (a region that missed its density target by
// more than 15%, say) reached nobody. A check whose output no surface consumes
// has stopped being a check, whatever it prints into its own JSON.
//
// `problems` and `caveats` are deliberately distinct on the generator's side:
// problems gate its `ok` flag, caveats do not, because a labelling or
// tolerance concern should not fail a region outright. Rendered with that
// difference intact rather than flattened into one list.
function ReportPanel({ name, version }) {
  const { caveats, problems, notes, isLoadingReport, reportError } = useRegionReport(name, version);
  if (isLoadingReport || reportError) return null;   // the spec panel already reports a dead service
  if (!caveats.length && !problems.length) return null;
  return (
    <div>
      {problems.length > 0 && (
        <ErrorBanner>
          <HiOutlineExclamationTriangle size={20} />
          <div>
            <strong>The generator reports {problems.length} problem(s) with this region.</strong>
            <Mono>{problems.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join('\n')}</Mono>
          </div>
        </ErrorBanner>
      )}
      {caveats.length > 0 && (
        <Mono>{`caveats from the generator (these do not fail the region):\n`
          + caveats.map(c => `  - ${typeof c === 'string' ? c : JSON.stringify(c)}`).join('\n')
          + (notes.length ? `\n\n${notes.map(n => `note: ${n}`).join('\n')}` : '')}</Mono>
      )}
    </div>
  );
}

function SpecPanel({ name }) {
  const { spec, valid, specErrors, isLoadingSpec, specError } = useRegionSpec(name);
  if (isLoadingSpec) return <Stat>Checking the spec against this database…</Stat>;
  if (specError) {
    return (
      <ErrorBanner>
        <HiOutlineExclamationTriangle size={20} />
        <div><strong>Could not read the spec.</strong><div>{specError.message}</div></div>
      </ErrorBanner>
    );
  }
  if (!spec) return null;
  return (
    <div>
      <Row>
        <Badge $bg={valid ? 'var(--s2-accent)' : 'var(--s2-danger, #b4423a)'}>
          {valid ? 'validates against this database' : `${specErrors.length} validation error(s)`}
        </Badge>
        <Stat>{spec.worlds?.length ?? 0} worlds · {spec.links?.length ?? 0} links · topology {spec.topology}</Stat>
      </Row>
      {/* Shown in full rather than truncated: these are the lines that get sent
          back to whoever generated the spec, and a half-quoted error is not
          actionable. */}
      {!valid && specErrors.length > 0 && <Mono>{specErrors.join('\n')}</Mono>}
    </div>
  );
}

// Seeding is the most destructive action in the admin UI -- it rewrites the
// world graph players navigate and removes live doorways the spec does not
// declare, and one spec per database means seeding a second region strands the
// first one's worlds. So the confirmation is the region's NAME typed back, not
// a checkbox: a boolean is too easy to click past.
function SeedConfirm({ name, onCancel, onSeeded }) {
  const [typed, setTyped] = useState('');
  const seed = useSeedRegion();
  return (
    <Card>
      <Row><HiOutlineExclamationTriangle size={20} /><strong>Seed “{name}” into this database?</strong></Row>
      <Stat>
        This ADDS the region alongside the maps already in this database — the authored worlds
        stay, keep their doorways and keep rendering. The game’s entry world is <strong>kept as
        it is</strong>, so players still start where they start now. Doorways belonging to
        <em> this spec’s own</em> worlds that it does not declare are removed. The backend must
        be restarted afterwards.
      </Stat>
      <Row>
        <Label>Type “{name}”</Label>
        <Input value={typed} onChange={e => setTyped(e.target.value)} placeholder={name} />
        <Button
          $bg="var(--s2-danger, #b4423a)"
          disabled={typed !== name || seed.isPending}
          onClick={() => seed.mutate({ name }, {
            onSuccess: (data) => { if (onSeeded) onSeeded(data); onCancel(); },
          })}
        >
          {seed.isPending ? 'Seeding…' : 'Seed it'}
        </Button>
        <Button $bg="var(--s2-border)" onClick={onCancel}>Cancel</Button>
      </Row>
    </Card>
  );
}

function CreateForm() {
  const [form, setForm] = useState({
    name: '', worlds: 6, target_per_screen: 6, size: 128, chunk_size: 32, biome_cell: 32, theme: '',
  });
  const create = useCreateRegion();
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  return (
    <Card>
      <strong>Generate a new region</strong>
      <Row><Label>Name</Label><Input value={form.name} onChange={e => set('name', e.target.value)} placeholder="emerald-reach" /></Row>
      <Row><Label>Theme</Label>
        <Input
          style={{ flex: 1, minWidth: 260 }}
          value={form.theme}
          onChange={e => set('theme', e.target.value)}
          placeholder="a green river valley that descends into buried ruins"
        />
      </Row>
      <Row>
        <Label>Worlds</Label><Input type="number" min="1" value={form.worlds} onChange={e => set('worlds', e.target.value)} />
        <Label>Creatures / screen</Label>
        <Input type="number" step="0.1" min="0" value={form.target_per_screen} onChange={e => set('target_per_screen', e.target.value)} />
        <AchievedNote requested={form.target_per_screen} />
      </Row>
      <AchievablePicks onPick={v => set('target_per_screen', v)} />
      <Row>
        <Label>Size (tiles)</Label><Input type="number" value={form.size} onChange={e => set('size', e.target.value)} />
        <Label>Chunk</Label><Input type="number" value={form.chunk_size} onChange={e => set('chunk_size', e.target.value)} />
        <Label>Biome cell</Label><Input type="number" value={form.biome_cell} onChange={e => set('biome_cell', e.target.value)} />
      </Row>
      <Row>
        <Button
          disabled={!form.name.trim() || create.isPending}
          onClick={() => create.mutate({
            name: form.name.trim(),
            theme: form.theme.trim() || undefined,
            worlds: num(form.worlds, 6),
            target_per_screen: num(form.target_per_screen, 6),
            size: num(form.size, 128),
            chunk_size: num(form.chunk_size, 32),
            biome_cell: num(form.biome_cell, 32),
          })}
        >
          <HiOutlineSparkles /> {create.isPending ? 'Generating…' : 'Generate'}
        </Button>
        <Stat>Spec generation is arithmetic on the far side — seconds, not minutes.</Stat>
      </Row>
    </Card>
  );
}

// Edit sends ONE field. That is the point: the generator carries over every
// field a PATCH omits, including the biome plan, so raising the creature
// target must not redraw the region's character.
function EditForm({ region }) {
  const [target, setTarget] = useState(region.params?.target_per_screen ?? '');
  const edit = useEditRegion();
  return (
    <Row>
      <Label>Creatures / screen</Label>
      <Input type="number" step="0.1" min="0" value={target} onChange={e => setTarget(e.target.value)} />
      <Button
        disabled={edit.isPending || String(target) === String(region.params?.target_per_screen ?? '')}
        onClick={() => edit.mutate({ name: region.name, patch: { target_per_screen: num(target, 0) } })}
      >
        {edit.isPending ? 'Rebuilding…' : 'Apply'}
      </Button>
      <AchievedNote requested={target} />
      <Stat>Rebuilds against the same biome plan — the region’s character does not change.</Stat>
    </Row>
  );
}

function RegionCard({ region, selected, onSelect }) {
  const [confirmSeed, setConfirmSeed] = useState(false);
  const [seedResult, setSeedResult] = useState(null);
  const download = useDownloadRegion();
  const del = useDeleteRegion();
  const empty = Number(region.empty_worlds) > 0;
  return (
    <Card $selected={selected}>
      <Header>
        <Row>
          <strong style={{ fontSize: '1.05rem' }}>{region.name}</strong>
          {empty && <Badge $bg="var(--s2-danger, #b4423a)">{region.empty_worlds} EMPTY world(s)</Badge>}
          {region.ok === false && <Badge $bg="var(--s2-danger, #b4423a)">problems reported</Badge>}
          {region.editable && <Badge>editable</Badge>}
        </Row>
        <Button $bg="var(--s2-border)" onClick={() => onSelect(selected ? null : region.name)}>
          {selected ? 'Hide' : 'Preview'}
        </Button>
      </Header>
      <Row>
        <Stat>{region.worlds} worlds</Stat>
        <Stat>· {region.creatures} creatures</Stat>
        <Stat>· {region.mean_per_screen} per screen (mean)</Stat>
        {region.params?.theme && <Stat>· “{region.params.theme}”</Stat>}
      </Row>

      {selected && (
        <>
          {/* Keyed on the numbers the generator recomputes, so an edit that
              rebuilds the region also refetches its picture. */}
          <PreviewPanel name={region.name} version={`${region.creatures}:${region.mean_per_screen}:${region.worlds}`} />
          <SpecPanel name={region.name} />
          <ReportPanel name={region.name} version={`${region.creatures}:${region.mean_per_screen}`} />
          {region.editable && <EditForm region={region} />}
          <Row>
            <Button
              disabled={download.isPending}
              onClick={() => download.mutate({ name: region.name })}
            >
              <HiOutlineArrowDownTray /> {download.isPending ? 'Writing…' : 'Download to seeds/maps'}
            </Button>
            <Button $bg="var(--s2-danger, #b4423a)" onClick={() => setConfirmSeed(true)}>Seed into this database</Button>
            <Button
              $bg="var(--s2-border)"
              disabled={del.isPending}
              onClick={() => del.mutate({ name: region.name })}
            >
              <HiOutlineTrash /> Delete from service
            </Button>
          </Row>
          {download.data?.written && (
            <Mono>{`wrote ${download.data.written}${download.data.overwrote ? ' (overwrote an existing file)' : ''}\nthen: ${download.data.seedCommand}`}</Mono>
          )}
          {confirmSeed && (
            <SeedConfirm
              name={region.name}
              onCancel={() => setConfirmSeed(false)}
              onSeeded={setSeedResult}
            />
          )}
          {/* What happened to the game's front door, in the route's own words. */}
          {seedResult?.entry?.note && <Mono>{seedResult.entry.note}</Mono>}
        </>
      )}
    </Card>
  );
}

export default function WorldGenAdmin() {
  const [selected, setSelected] = useState(null);
  const {
    regions, total, provider, isLoadingRegions, isRefetchingRegions, regionsError, refetchRegions,
  } = useGeneratedWorlds();

  return (
    <AdminContainer>
      <Header>
        <h2 style={{ margin: 0 }}>Generated Worlds</h2>
        <Button $bg="var(--s2-border)" onClick={() => refetchRegions()} disabled={isRefetchingRegions}>
          <HiOutlineArrowPath /> {isRefetchingRegions ? 'Refreshing…' : 'Refresh'}
        </Button>
      </Header>
      <Sub>
        Region specs from the remote world generator{provider ? ` (via AI connector “${provider}”)` : ''}.
        Layout is in tiles, positions in pixels at 100 px per tile.
      </Sub>

      {/* Errors are rendered, never collapsed into an empty list. */}
      {regionsError && (
        <ErrorBanner>
          <HiOutlineExclamationTriangle size={20} />
          <div>
            <strong>Could not list regions.</strong>
            <div>{regionsError.message}</div>
          </div>
        </ErrorBanner>
      )}

      <CreateForm />

      {isLoadingRegions && <Stat>Loading regions…</Stat>}
      {!isLoadingRegions && !regionsError && regions.length === 0 && (
        <Stat>The generator is reachable and holds no regions yet. Generate one above.</Stat>
      )}
      {regions.map(r => (
        <RegionCard key={r.name} region={r} selected={selected === r.name} onSelect={setSelected} />
      ))}
      {regions.length > 0 && <Stat>{total} region(s) on the service.</Stat>}
    </AdminContainer>
  );
}
