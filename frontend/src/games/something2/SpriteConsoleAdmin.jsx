import { useMemo, useState } from 'react';
import styled from 'styled-components';
import SpritePreviewModal from './SpritePreviewModal.jsx';
import AdminLoading from './AdminLoading.jsx';
import { assetUrlVersioned } from './useTileSprites.js';
import {
  useActionCatalog, useApproveSpriteJobs, useClearSpriteJobs, useQueueSprites, useRescueSpriteJobs,
  useSpriteQueue, useSpriteSubjects, useStartSpriteBatch, useStopSpriteBatch,
} from './useSpriteConsole.js';
import {
  cellCount, defaultActions, estimateLabel, filterSpriteSubjects, framesCap, isSpritePageSelected, selectAllSpriteSubjects, setSpritePageSelected, spritePage,
  spriteShape, targetsForSprites, toggleSpriteSubject,
} from './spriteSelection.js';

const Wrap = styled.div`
  padding: 2rem; color: var(--s2-text); max-width: 1200px; margin: 0 auto;
  height: 100%; overflow-y: auto; background: var(--s2-surface);
`;
const Bar = styled.div`
  display: flex; gap: 0.75rem; flex-wrap: wrap; align-items: flex-end; margin: 0.75rem 0;
`;
const Field = styled.label`
  display: flex; flex-direction: column; gap: 0.25rem; color: var(--s2-text-muted); font-size: 0.8rem;
  input, select {
    min-width: 140px; padding: 0.4rem; color: var(--s2-text);
    background: var(--s2-bg-sunken); border: 1px solid var(--s2-border-strong); border-radius: 4px;
  }
`;
const Button = styled.button`
  border: 0; border-radius: 6px; padding: 0.45rem 0.9rem; cursor: pointer;
  color: var(--s2-on-accent); background: var(--s2-accent); font-weight: 700;
  &:disabled { opacity: 0.5; cursor: default; }
`;
const Secondary = styled(Button)`background: var(--s2-btn-grey);`;
const Hint = styled.p`margin: 0.35rem 0; color: var(--s2-text-muted); font-size: 0.85rem;`;
const Progress = styled.section`
  padding: 0.75rem 1rem; border: 1px solid var(--s2-border); border-radius: 8px;
  background: var(--s2-surface-raised); margin: 0.75rem 0;
`;
const TableWrap = styled.div`
  overflow-x: auto; border: 1px solid var(--s2-border); border-radius: 8px;
  background: var(--s2-surface-raised);
`;
const Table = styled.table`
  width: 100%; border-collapse: collapse; font-size: 0.85rem;
  th, td { text-align: left; padding: 0.45rem 0.6rem; border-bottom: 1px solid var(--s2-border); }
  th { color: var(--s2-text-muted); font-weight: 500; }
  tbody tr:hover { background: var(--s2-overlay); }
`;
const Thumb = styled.img`
  width: 38px; height: 38px; object-fit: contain; image-rendering: pixelated;
  background: var(--s2-bg-sunken); border: 1px solid var(--s2-border); border-radius: 4px;
`;
const Pill = styled.span`
  display: inline-block; border-radius: 999px; padding: 0.1rem 0.45rem;
  color: var(--s2-text-muted); background: var(--s2-bg-sunken); font-size: 0.75rem;
`;
const Banner = styled.div`
  margin: 0.75rem 0; padding: 0.6rem 0.9rem; border-radius: 6px;
  color: var(--s2-danger); border: 1px solid var(--s2-danger); background: var(--s2-bg-sunken);
`;
const Check = styled.label`display: inline-flex; gap: 0.3rem; align-items: center; font-size: 0.85rem;`;
const ErrorText = styled.span`color: var(--s2-danger);`;
const ThumbButton = styled.button`border: 0; padding: 0; background: none; cursor: zoom-in;`;
const Pager = styled.div`display: flex; gap: 0.5rem; align-items: center; margin: 0.75rem 0;`;

function derivedFrames(subject) {
  return spriteShape(subject) === 'directional' || subject.render_mode === 'animated' ? 4 : 1;
}

function SpriteConsoleAdmin() {
  const { stats, run } = useSpriteQueue();
  const live = Boolean(run?.running || stats.queued || stats.running);
  const { subjects, isLoading, error } = useSpriteSubjects({ live });
  const [shape, setShape] = useState('all');
  const [status, setStatus] = useState('missing');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(new Set());
  const [previewId, setPreviewId] = useState(null);
  const { catalog, isLoading: catalogLoading, error: catalogError } = useActionCatalog();
  const [chosenActions, setChosenActions] = useState(null);
  const [chosenFrames, setChosenFrames] = useState(4);
  const queue = useQueueSprites();
  const start = useStartSpriteBatch();
  const stop = useStopSpriteBatch();
  const rescue = useRescueSpriteJobs();
  const clear = useClearSpriteJobs();
  const approve = useApproveSpriteJobs();

  const previewSubject = subjects.find((subject) => subject.id === previewId);

  const matching = useMemo(
    () => filterSpriteSubjects(subjects, { shape, status, search }),
    [subjects, shape, status, search],
  );
  const shown = spritePage(matching, page);
  // A filter change starts from page 1; page 4 of the old filter means nothing.
  const filter = (set) => (event) => { set(event.target.value); setPage(1); };
  const selectedRows = subjects.filter((subject) => selected.has(subject.id));
  const approvable = selectedRows.filter((subject) => subject.job_state === 'done' && subject.job_id);

  // null = untouched, so the defaults follow the catalog once it loads.
  const actions = chosenActions ?? defaultActions(catalog);
  const cap = framesCap(catalog, actions);
  const frames = Math.min(chosenFrames, cap);
  const cells = cellCount(selectedRows, actions, frames);
  const toggleAction = (id) => setChosenActions(
    actions.includes(id) ? actions.filter((a) => a !== id) : [...actions, id],
  );
  const catalogReady = Boolean(catalog) && !catalogLoading && !catalogError;
  const canQueue = catalogReady && selected.size > 0 && actions.length > 0 && !queue.isPending;

  const enqueue = () => queue.mutate(
    { targets: targetsForSprites(selectedRows), actions, frames },
    { onSuccess: () => setSelected(new Set()) },
  );
  const approveSelected = () => approve.mutate(
    approvable.map((subject) => subject.job_id),
    { onSuccess: () => setSelected(new Set()) },
  );

  // Above AND below the table: at 100 rows the bottom copy is far down the page.
  const pager = shown.pages > 1 && (
    <Pager>
      <Secondary onClick={() => setPage(shown.page - 1)} disabled={shown.page <= 1}>Prev</Secondary>
      <span>Page {shown.page} of {shown.pages}</span>
      <Secondary onClick={() => setPage(shown.page + 1)} disabled={shown.page >= shown.pages}>Next</Secondary>
    </Pager>
  );

  if (isLoading) return <Wrap><AdminLoading label="Loading sprite subjects…" /></Wrap>;
  if (error) return <Wrap><ErrorText>{error.message}</ErrorText></Wrap>;

  return (
    <Wrap>
      <h2>Sprite generation</h2>
      <Hint>
        Options come from each entity: prompt and creature/prop shape.
        {catalog?.engine?.label ? ` Engine: ${catalog.engine.label}. ` : ' '}
        Jobs run on the GPU box; a single image from a registered provider belongs in Art
        Generation, which cuts it out before it reaches the entity.
      </Hint>
      {catalogError && <Banner role="alert">{catalogError.message}</Banner>}

      <Progress>
        <strong>{run?.running ? 'Batch running' : 'Batch idle'}</strong>
        <Hint>
          {stats.queued || 0} queued · {stats.running || 0} running · {stats.done || 0} ready for review
          {' · '}{stats.failed || 0} failed · {stats.approved || 0} approved
        </Hint>
        {run?.current && <Hint>Generating {run.current.creature}</Hint>}
      </Progress>

      <Bar>
        <Field>Shape
          <select value={shape} onChange={filter(setShape)}>
            <option value="all">All shapes</option>
            <option value="directional">Directional creatures</option>
            <option value="flat">Flat props</option>
          </select>
        </Field>
        <Field>Status
          <select value={status} onChange={filter(setStatus)}>
            <option value="missing">Missing visual</option>
            <option value="queued">Queued</option>
            <option value="running">Running</option>
            <option value="done">Ready for review</option>
            <option value="failed">Failed</option>
            <option value="approved">Approved</option>
            <option value="all">Any</option>
          </select>
        </Field>
        <Field>Search
          <input value={search} onChange={filter(setSearch)} placeholder="entity name" />
        </Field>
      </Bar>

      <Bar>
        <Field as="div">Actions
          <span style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            {(catalog?.actions || []).map((action) => (
              <Check key={action.id}>
                <input type="checkbox" checked={actions.includes(action.id)}
                  onChange={() => toggleAction(action.id)} />
                {action.label}
              </Check>
            ))}
          </span>
        </Field>
        <Field>Frames
          <select value={frames} disabled={!catalogReady}
            onChange={(event) => setChosenFrames(Number(event.target.value))}>
            {Array.from({ length: cap }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </Field>
        <Button disabled={!canQueue} onClick={enqueue}>
          Queue {selected.size} selected
        </Button>
        {catalogReady && selected.size > 0 && actions.length > 0 && (
          <Hint>{estimateLabel(cells, catalog.seconds_per_cell)}</Hint>
        )}
        <Secondary disabled={matching.length === 0}
          onClick={() => setSelected(selectAllSpriteSubjects(matching))}>
          Select all {matching.length} matching
        </Secondary>
        <Secondary disabled={selected.size === 0} onClick={() => setSelected(new Set())}>Clear selection</Secondary>
        <Button disabled={run?.running || !(stats.queued > 0)} onClick={() => start.mutate()}>
          {run?.running ? 'Running…' : 'Start batch'}
        </Button>
        {run?.running && <Secondary onClick={() => stop.mutate()}>Stop</Secondary>}
        <Secondary onClick={() => rescue.mutate()}>Rescue stranded</Secondary>
        <Secondary disabled={run?.running || !(stats.queued > 0)} onClick={() => {
          if (window.confirm(`Clear ${stats.queued || 0} queued sprite jobs?`)) clear.mutate();
        }}>Clear queue</Secondary>
        <Button disabled={approvable.length === 0 || approve.isPending} onClick={approveSelected}>
          Approve {approvable.length} completed
        </Button>
      </Bar>

      <Hint>{matching.length} matching · {selected.size} selected</Hint>
      {pager}
      <TableWrap>
        <Table>
          <thead><tr>
            <th><input type="checkbox" aria-label="Select this page"
              checked={isSpritePageSelected(selected, shown.rows)}
              onChange={(event) => setSelected(setSpritePageSelected(selected, shown.rows, event.target.checked))} /></th>
            <th>Concept</th><th>Sheet</th><th>Entity</th><th>Shape</th><th>Actions</th><th>Frames</th><th>Backend</th><th>Status</th><th>Prompt</th>
          </tr></thead>
          <tbody>
            {shown.rows.map((subject) => {
              const sheet = subject.atlas_key || subject.image_key || subject.image;
              const thumb = (key, label) => (key ? (
                <ThumbButton type="button" aria-label={`${label}: ${subject.name}`} onClick={() => setPreviewId(subject.id)}>
                  <Thumb src={assetUrlVersioned(key, subject.job_updated_at)} alt="" />
                </ThumbButton>
              ) : '—');
              return (
                <tr key={subject.id}>
                  <td><input type="checkbox" checked={selected.has(subject.id)}
                    onChange={() => setSelected(toggleSpriteSubject(selected, subject.id))} /></td>
                  <td>{thumb(subject.concept_key, 'Preview concept')}</td>
                  <td>{thumb(sheet, 'Preview sheet')}</td>
                  <td>{subject.name}</td>
                  <td><Pill>{spriteShape(subject)}</Pill></td>
                  <td>{Array.isArray(subject.actions) && subject.actions.length ? subject.actions.join(' · ') : '—'}</td>
                  <td>{subject.backend === 'gpu-box' && subject.frames_per_action
                    ? `${subject.frames_per_action} / action` : derivedFrames(subject)}</td>
                  <td>{subject.backend || 'local'}</td>
                  <td>{subject.job_state === 'failed'
                    ? <ErrorText title={subject.last_error || ''}>failed</ErrorText>
                    : <Pill>{subject.job_state || 'not queued'}</Pill>}</td>
                  <td title={subject.prompt || subject.name}>{subject.prompt || subject.name}</td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </TableWrap>
      {pager}
      {previewSubject && <SpritePreviewModal subject={previewSubject} onClose={() => setPreviewId(null)} />}
    </Wrap>
  );
}

export default SpriteConsoleAdmin;
