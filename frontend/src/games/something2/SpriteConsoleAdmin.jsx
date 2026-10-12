import { useMemo, useState } from 'react';
import styled from 'styled-components';
import AdminLoading from './AdminLoading.jsx';
import { assetUrlVersioned } from './useTileSprites.js';
import {
  useApproveSpriteJobs, useClearSpriteJobs, useQueueSprites, useRescueSpriteJobs,
  useSpriteQueue, useSpriteSubjects, useStartSpriteBatch, useStopSpriteBatch,
} from './useSpriteConsole.js';
import {
  filterSpriteSubjects, selectAllSpriteSubjects, spriteShape, toggleSpriteSubject,
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
const ErrorText = styled.span`color: var(--s2-danger);`;

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
  const [selected, setSelected] = useState(new Set());
  const queue = useQueueSprites();
  const start = useStartSpriteBatch();
  const stop = useStopSpriteBatch();
  const rescue = useRescueSpriteJobs();
  const clear = useClearSpriteJobs();
  const approve = useApproveSpriteJobs();

  const matching = useMemo(
    () => filterSpriteSubjects(subjects, { shape, status, search }),
    [subjects, shape, status, search],
  );
  const selectedRows = subjects.filter((subject) => selected.has(subject.id));
  const approvable = selectedRows.filter((subject) => subject.job_state === 'done' && subject.job_id);

  const enqueue = () => queue.mutate([...selected], { onSuccess: () => setSelected(new Set()) });
  const approveSelected = () => approve.mutate(
    approvable.map((subject) => subject.job_id),
    { onSuccess: () => setSelected(new Set()) },
  );

  if (isLoading) return <Wrap><AdminLoading label="Loading sprite subjects…" /></Wrap>;
  if (error) return <Wrap><ErrorText>{error.message}</ErrorText></Wrap>;

  return (
    <Wrap>
      <h2>Sprite generation</h2>
      <Hint>
        Options come from each entity: prompt, creature/prop shape and animation frames. Every job
        runs on the local sprite service; a single image from a registered provider belongs in Art
        Generation, which cuts it out before it reaches the entity.
      </Hint>

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
          <select value={shape} onChange={(event) => setShape(event.target.value)}>
            <option value="all">All shapes</option>
            <option value="directional">Directional creatures</option>
            <option value="flat">Flat props</option>
          </select>
        </Field>
        <Field>Status
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
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
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="entity name" />
        </Field>
      </Bar>

      <Bar>
        <Button disabled={selected.size === 0 || queue.isPending} onClick={enqueue}>
          Queue {selected.size} selected
        </Button>
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
      <TableWrap>
        <Table>
          <thead><tr>
            <th aria-label="Select" />
            <th>Preview</th><th>Entity</th><th>Shape</th><th>Frames</th><th>Backend</th><th>Status</th><th>Prompt</th>
          </tr></thead>
          <tbody>
            {matching.map((subject) => {
              const preview = subject.image_key || subject.atlas_key || subject.image;
              return (
                <tr key={subject.id}>
                  <td><input type="checkbox" checked={selected.has(subject.id)}
                    onChange={() => setSelected(toggleSpriteSubject(selected, subject.id))} /></td>
                  <td>{preview ? <Thumb src={assetUrlVersioned(preview, subject.job_updated_at)} alt="" /> : '—'}</td>
                  <td>{subject.name}</td>
                  <td><Pill>{spriteShape(subject)}</Pill></td>
                  <td>{derivedFrames(subject)}</td>
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
    </Wrap>
  );
}

export default SpriteConsoleAdmin;
