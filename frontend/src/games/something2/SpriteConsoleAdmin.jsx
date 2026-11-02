import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useCreateEntityType } from './useMaps.js';
import styled from 'styled-components';
import SpritePreviewModal from './SpritePreviewModal.jsx';
import AdminLoading from './AdminLoading.jsx';
import { assetUrlVersioned } from './useTileSprites.js';
import {
  useActionCatalog, useApproveSpriteJobs, useClearConcepts, useClearSpriteJobs, useDeleteGenerated, useForceRegenerate, useHaltSpriteBatch, useQueueSprites, useRescueSpriteJobs, useRetryBoxCancel,
  SUBJECTS_KEY, useSpriteQueue, useSpriteSubjects, useStartSpriteBatch, useStopSpriteBatch,
} from './useSpriteConsole.js';
import {
  boxCancelLines, startBatchWarning, forceConfirmText, refusedLines, cellCount, conceptImageOf, DEFAULT_DIRECTIONS, DIRECTION_PRESETS, SPRITE_DIRECTIONS, directionsLabel, hasWestern, presetOf, queueBlockReason, toggleDirection, deleteConfirmText, isPropSubject, newConceptConfirmText, nextConceptCaption, lastUpdateLabel, targetsForSprites, defaultActionsFor, sheetImageOf, isBoxProp, estimateLabel, batchProgress, currentProgressLabel, rowProgressLabel, jobStateLabel, filterSpriteSubjects, framesCap, isSpritePageSelected, selectAllSpriteSubjects, setSpritePageSelected, spritePage,
  newCreatureBody, newCreatureError,
  DEFAULT_PROP_FX, PROP_FX_OPTIONS, propFxLabel, queueButtonLabel, queuePayload, queueIsLive, selectionKinds, spriteShape, toggleSpriteSubject,
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
const BatchBar = styled.div`
  height: 6px; margin: 0.4rem 0; border-radius: 999px; overflow: hidden; background: var(--s2-bg-sunken);
  > div { height: 100%; background: var(--s2-accent); transition: width 0.4s ease; }
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
// Each action is one clickable chip, box and label together. Field's
// `input { min-width: 140px }` is undone here: it stretched every checkbox
// away from its own label, so a click near a label hit the neighbour's box.
const ActionChips = styled.span`display: flex; gap: 0.4rem; flex-wrap: wrap;`;
const Check = styled.label`
  display: inline-flex; gap: 0.4rem; align-items: center; cursor: pointer; user-select: none;
  padding: 0.3rem 0.6rem; border: 1px solid var(--s2-border-strong); border-radius: 999px;
  color: var(--s2-text); background: var(--s2-bg-sunken); font-size: 0.85rem;
  &:has(input:checked) { border-color: var(--s2-accent); }
  && input { min-width: 0; margin: 0; padding: 0; cursor: pointer; }
`;
const ErrorText = styled.span`color: var(--s2-danger);`;
const Caption = styled.span`display: block; margin-top: 0.2rem; color: var(--s2-text-muted); font-size: 0.72rem;`;
const ThumbButton = styled.button`border: 0; padding: 0; background: none; cursor: zoom-in;`;
const Pager = styled.div`display: flex; gap: 0.5rem; align-items: center; margin: 0.75rem 0;`;

// Open GPU-box cancels (SOMET-695), one status line per row.
export function BoxCancelLines({ lines, onRetry, retrying = false }) {
  if (!lines.length) return null;
  return (
    <>
      {lines.map((line) => (
        <Hint key={line.id} role="status">
          {line.text}
          {line.retry && <> <Secondary disabled={retrying} onClick={() => onRetry(line.id)}>Retry cancel</Secondary></>}
        </Hint>
      ))}
    </>
  );
}

// The Status column: "failed" / "redraw failed" in red with the error as its
// title, else the live progress ("running 37%" / "redrawing 37%") or the state.
export function JobStatusCell({ subject, run }) {
  if (subject.job_state === 'failed') {
    return <ErrorText title={subject.last_error || ''}>{jobStateLabel(subject)}</ErrorText>;
  }
  return <Pill>{rowProgressLabel(subject, run) || jobStateLabel(subject)}</Pill>;
}

function derivedFrames(subject) {
  return spriteShape(subject) === 'directional' || subject.render_mode === 'animated' ? 4 : 1;
}

// Selected rows -> mutate body; `names` maps a selected row's id to its display name for toasts.
export function selectionBody(rows) {
  return { targets: targetsForSprites(rows), names: Object.fromEntries(rows.map((row) => [row.id, row.name])) };
}

// Nothing is sent unless the operator confirms.
export function confirmAndDelete(confirmFn, mutateFn, rows) {
  if (!confirmFn(deleteConfirmText(rows.length))) return false;
  mutateFn(selectionBody(rows));
  return true;
}

// Nothing is sent unless the operator confirms.
export function confirmAndClearConcepts(confirmFn, mutateFn, rows) {
  if (!confirmFn(newConceptConfirmText(rows.length))) return false;
  mutateFn(selectionBody(rows));
  return true;
}

export function ConceptButtons({ count, deletePending, clearPending, onDelete, onClear }) {
  return (
    <>
      <Secondary disabled={count === 0 || deletePending} onClick={onDelete}>Delete generated</Secondary>
      <Secondary disabled={count === 0 || clearPending} onClick={onClear}>New concept</Secondary>
    </>
  );
}

// Which facings a creature sheet is drawn in: 2/4/8-way presets plus one tick
// per direction. West-facing rows from the box have been bad, so ticking one warns.
export function DirectionsField({ directions, onChange }) {
  const preset = presetOf(directions);
  return (
    <Field as="div">
      {`Directions (${directions.length} of ${SPRITE_DIRECTIONS.length}) · ${preset ? `${preset}-way` : `custom (${directions.length})`}`}
      <ActionChips>
        {Object.keys(DIRECTION_PRESETS).map((n) => (
          <Secondary key={n} type="button" aria-pressed={preset === Number(n)}
            onClick={() => onChange([...DIRECTION_PRESETS[n]])}>{`${n}-way`}</Secondary>
        ))}
      </ActionChips>
      <ActionChips>
        {SPRITE_DIRECTIONS.map((id) => (
          <Check key={id}>
            <input type="checkbox" checked={directions.includes(id)}
              onChange={() => onChange(toggleDirection(directions, id))} />
            {id}
          </Check>
        ))}
      </ActionChips>
      {hasWestern(directions) && (
        <Hint>West-facing rows from the box have looked wrong before — check them in the preview.</Hint>
      )}
    </Field>
  );
}

export function SpriteTable({ rows, selected, run, onToggle, onTogglePage, onPreview }) {
  return (
    <TableWrap>
      <Table>
        <thead><tr>
          <th><input type="checkbox" aria-label="Select this page"
            checked={isSpritePageSelected(selected, rows)}
            onChange={(event) => onTogglePage(event.target.checked)} /></th>
          <th>Concept</th><th>Sheet / Result</th><th>Entity</th><th>Shape</th><th>Actions</th><th>Directions</th><th>Frames</th><th>Backend</th><th>Status</th><th>Last update</th><th>Prompt</th>
        </tr></thead>
        <tbody>
          {rows.map((subject) => {
            const sheet = sheetImageOf(subject);
            const thumb = (key, label) => (key ? (
              <ThumbButton type="button" aria-label={`${label}: ${subject.name}`} onClick={() => onPreview(subject.id)}>
                <Thumb src={assetUrlVersioned(key, subject.job_updated_at)} alt="" />
              </ThumbButton>
            ) : '—');
            const concept = conceptImageOf(subject);
            const lastUpdate = lastUpdateLabel(subject.job_updated_at);
            return (
              <tr key={subject.id}>
                <td><input type="checkbox" checked={selected.has(subject.id)}
                  onChange={() => onToggle(subject.id)} /></td>
                <td>{concept ? (
                  <>{thumb(concept, 'Preview concept')}<Caption>{nextConceptCaption(subject)}</Caption></>
                ) : isPropSubject(subject) ? '—' : <Hint>{nextConceptCaption(subject)}</Hint>}</td>
                <td>{thumb(sheet, isBoxProp(subject) ? 'Preview result' : 'Preview sheet')}</td>
                <td>{subject.name}</td>
                <td><Pill>{spriteShape(subject)}</Pill></td>
                {/* A prop's queued actions mean nothing; show its effect instead. */}
                <td>{isBoxProp(subject) && subject.prop_fx ? `effect: ${propFxLabel(subject.prop_fx)}`
                  : Array.isArray(subject.actions) && subject.actions.length ? subject.actions.join(' · ') : '—'}</td>
                <td>{directionsLabel(subject)}</td>
                <td>{subject.backend === 'gpu-box' && subject.frames_per_action
                  ? `${subject.frames_per_action} / action` : derivedFrames(subject)}</td>
                <td>{subject.backend || 'local'}</td>
                <td><JobStatusCell subject={subject} run={run} /></td>
                <td title={lastUpdate.title}>{lastUpdate.text}</td>
                <td title={subject.prompt || subject.name}>{subject.prompt || subject.name}</td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </TableWrap>
  );
}

// The New creature form (SOMET-699), presentational: the container owns the state.
export function NewCreatureFormView({ open, name, prompt, shape, error, pending, onToggle, onChange, onSubmit }) {
  return (
    <>
      <Secondary type="button" aria-expanded={open} onClick={onToggle}>New creature</Secondary>
      {open && (
        <Bar as="form" aria-label="New creature" onSubmit={onSubmit}>
          <Field>Name
            <input value={name} onChange={(event) => onChange({ name: event.target.value })} placeholder="required" />
          </Field>
          <Field>Prompt
            <textarea value={prompt} rows={2} onChange={(event) => onChange({ prompt: event.target.value })}
              placeholder="optional description" />
          </Field>
          <Field>Kind
            <select value={shape} onChange={(event) => onChange({ shape: event.target.value })}>
              <option value="creature">Creature</option>
              <option value="prop">Prop</option>
            </select>
          </Field>
          <Button type="submit" disabled={pending}>{pending ? 'Creating…' : 'Create'}</Button>
          {error && <ErrorText role="alert">{error}</ErrorText>}
        </Bar>
      )}
    </>
  );
}

function SpriteConsoleAdmin() {
  const { stats, run, boxCancels } = useSpriteQueue();
  const retryCancel = useRetryBoxCancel();
  const startWarning = startBatchWarning(boxCancels);
  const batch = batchProgress(run);
  const live = queueIsLive({ run, stats });
  const { subjects, isLoading, error } = useSpriteSubjects({ live });
  const [shape, setShape] = useState('all');
  const [status, setStatus] = useState('missing');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(new Set());
  const [previewId, setPreviewId] = useState(null);
  const { catalog, isLoading: catalogLoading, error: catalogError } = useActionCatalog();
  const [chosenActions, setChosenActions] = useState(null);
  // SOMET-669: 8 by default; `frames` below clamps it to the box's own cap.
  const [chosenFrames, setChosenFrames] = useState(8);
  // Props v2: the idle effect selected props get in game (prop_fx); drift by default.
  const [propFx, setPropFx] = useState(DEFAULT_PROP_FX);
  const [directions, setDirections] = useState(DEFAULT_DIRECTIONS);
  const queue = useQueueSprites();
  const forceRegenerate = useForceRegenerate();
  // Lines belong to the selection that was cleared when they arrived; any later selection change hides them.
  const [forceRefused, setForceRefused] = useState(null);
  const start = useStartSpriteBatch();
  const stop = useStopSpriteBatch();
  const halt = useHaltSpriteBatch();
  const rescue = useRescueSpriteJobs();
  const clear = useClearSpriteJobs();
  const approve = useApproveSpriteJobs();
  const deleteGenerated = useDeleteGenerated();
  const clearConcepts = useClearConcepts();
  const qc = useQueryClient();
  const createEntity = useCreateEntityType({ quiet: true });
  const [newForm, setNewForm] = useState({ open: false, name: '', prompt: '', shape: 'creature', error: null });
  const [createdNote, setCreatedNote] = useState(null);

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

  // null = untouched, so the defaults follow the catalog once it loads and the
  // current selection; any explicit tick keeps the user's choice.
  const actions = chosenActions ?? defaultActionsFor(catalog, selectedRows);
  const cap = framesCap(catalog, actions);
  const frames = Math.min(chosenFrames, cap);
  const kinds = selectionKinds(selectedRows);
  const payload = queuePayload(catalog, selectedRows, { actions, frames, propFx, directions });
  // A running job keeps its options, so its cells are not this press's work.
  const cells = cellCount(selectedRows.filter((row) => row.job_state !== 'running'), payload.actions, payload.frames, directions);
  const toggleAction = (id) => setChosenActions(
    actions.includes(id) ? actions.filter((a) => a !== id) : [...actions, id],
  );
  const catalogReady = Boolean(catalog) && !catalogLoading && !catalogError;
  const queueButton = queueButtonLabel(selectedRows);
  const blockReason = queueBlockReason(selectedRows, directions);
  const queueable = catalogReady && queueButton.actionable && payload.actions.length > 0 && !blockReason;
  const canQueue = queueable && !queue.isPending;

  const submitNewCreature = (event) => {
    event.preventDefault();
    const problem = newCreatureError(newForm.name);
    if (problem) { setNewForm((f) => ({ ...f, error: problem })); return; }
    setNewForm((f) => ({ ...f, error: null }));
    createEntity.mutate(newCreatureBody(newForm), {
      onSuccess: (created) => {
        const name = created?.name ?? newForm.name.trim();
        qc.invalidateQueries({ queryKey: SUBJECTS_KEY });
        setSearch(name); setStatus('all'); setShape('all'); setPage(1);
        setSelected(new Set([created.id]));
        setNewForm({ open: false, name: '', prompt: '', shape: 'creature', error: null });
        setCreatedNote(`Created ${name} — ready to queue.`);
      },
      onError: (err) => setNewForm((f) => ({ ...f, error: err.message })),
    });
  };

  const enqueue = () => queue.mutate(payload, { onSuccess: () => setSelected(new Set()) });
  const forceable = catalogReady && selectedRows.length > 0 && payload.actions.length > 0 && !blockReason
    && !forceRegenerate.isPending;
  const forceSelected = () => {
    if (!window.confirm(forceConfirmText(selectedRows.length))) return;
    const rows = selectedRows;
    setForceRefused(null);
    forceRegenerate.mutate(payload, {
      onSuccess: (data) => {
        const next = new Set();
        setSelected(next);
        setForceRefused({ lines: refusedLines(data.refused, rows), selection: next });
      },
    });
  };
  const approveSelected = () => approve.mutate(
    approvable.map((subject) => subject.job_id),
    { onSuccess: () => setSelected(new Set()) },
  );

  const deleteSelected = () => confirmAndDelete(
    (text) => window.confirm(text),
    (body) => deleteGenerated.mutate(body, { onSuccess: () => setSelected(new Set()) }),
    selectedRows,
  );
  const clearSelectedConcepts = () => confirmAndClearConcepts(
    (text) => window.confirm(text),
    (body) => clearConcepts.mutate(body),
    selectedRows,
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
        {run?.running && batch.totalCells > 0 && (
          <>
            <BatchBar role="progressbar" aria-label="Batch progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={batch.pct}>
              <div style={{ width: `${batch.pct}%` }} />
            </BatchBar>
            <Hint>
              Batch {batch.pct}% · {batch.doneCells.toLocaleString('en-US')} / {batch.totalCells.toLocaleString('en-US')} cells
              {batch.leftLabel && ` · ${batch.leftLabel}`}
            </Hint>
          </>
        )}
        {run?.current && (
          <Hint>Generating {run.current.creature}{currentProgressLabel(run) && ` · ${currentProgressLabel(run)}`}</Hint>
        )}
        <BoxCancelLines lines={boxCancelLines(boxCancels)} onRetry={(id) => retryCancel.mutate(id)} retrying={retryCancel.isPending} />
      </Progress>

      <Bar>
        <NewCreatureFormView {...newForm} pending={createEntity.isPending}
          onToggle={() => setNewForm((f) => ({ ...f, open: !f.open, error: null }))}
          onChange={(patch) => setNewForm((f) => ({ ...f, ...patch, error: null }))}
          onSubmit={submitNewCreature} />
      </Bar>
      {createdNote && <Hint role="status">{createdNote}</Hint>}

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
        {/* Actions and frames shape a creature's sheet; a prop is one image
            with an idle effect, so a props-only selection hides them. */}
        {kinds.propsOnly ? (
          <Hint>Props are one image each: actions and frames do not apply.</Hint>
        ) : (
          <>
            <Field as="div">
              Actions ({actions.length} of {catalog?.actions?.length ?? 0})
              <ActionChips>
                {(catalog?.actions || []).map((action) => (
                  <Check key={action.id}>
                    <input type="checkbox" checked={actions.includes(action.id)}
                      onChange={() => toggleAction(action.id)} />
                    {action.label}
                  </Check>
                ))}
              </ActionChips>
            </Field>
            <DirectionsField directions={directions} onChange={setDirections} />
            <Field>Frames
              <select value={frames} disabled={!catalogReady}
                onChange={(event) => setChosenFrames(Number(event.target.value))}>
                {Array.from({ length: cap }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </Field>
          </>
        )}
        {kinds.props && (
          <Field>Prop effect
            <select value={propFx} onChange={(event) => setPropFx(event.target.value)}>
              {PROP_FX_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </Field>
        )}
        <Button disabled={!canQueue} onClick={enqueue}>
          {queueButton.label}
        </Button>
        <Secondary disabled={!forceable} onClick={forceSelected}>
          Force regenerate {selectedRows.length} selected
        </Secondary>
        {blockReason && <Hint>{blockReason}</Hint>}
        {(forceRefused && forceRefused.selection === selected ? forceRefused.lines : []).map((line) => <Hint key={line} role="status">Not regenerated — {line}</Hint>)}
        {queueable && (
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
        {startWarning && <Hint>{startWarning}</Hint>}
        {/* Stop lets the sheet in progress finish; Halt cancels it on the box
            and puts that row back in the queue. */}
        {run?.running && <Secondary disabled={run.stopping} onClick={() => stop.mutate()}>Stop</Secondary>}
        {run?.running && (
          <Secondary disabled={run.halting} onClick={() => {
            const name = run.current?.creature;
            if (window.confirm(`Halt the batch now?${name ? ` ${name} is cancelled on the GPU box and goes back to the queue.` : ''}`)) halt.mutate();
          }}>{run.halting ? 'Halting…' : 'Halt'}</Secondary>
        )}
        <Secondary onClick={() => rescue.mutate()}>Rescue stranded</Secondary>
        <Secondary disabled={run?.running || !(stats.queued > 0)} onClick={() => {
          if (window.confirm(`Clear ${stats.queued || 0} queued sprite jobs?`)) clear.mutate();
        }}>Clear queue</Secondary>
        <ConceptButtons count={selectedRows.length} deletePending={deleteGenerated.isPending}
          clearPending={clearConcepts.isPending} onDelete={deleteSelected} onClear={clearSelectedConcepts} />
        <Button disabled={approvable.length === 0 || approve.isPending} onClick={approveSelected}>
          Approve {approvable.length} completed
        </Button>
      </Bar>

      <Hint>{matching.length} matching · {selected.size} selected</Hint>
      {pager}
      <SpriteTable rows={shown.rows} selected={selected} run={run}
        onToggle={(id) => setSelected(toggleSpriteSubject(selected, id))}
        onTogglePage={(on) => setSelected(setSpritePageSelected(selected, shown.rows, on))}
        onPreview={setPreviewId} />
      {pager}
      {previewSubject && <SpritePreviewModal subject={previewSubject} onClose={() => setPreviewId(null)} />}
    </Wrap>
  );
}

export default SpriteConsoleAdmin;
