import { Fragment, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useCreateEntityType } from './useMaps.js';
import styled from 'styled-components';
import SpritePreviewModal from './SpritePreviewModal.jsx';
import AdminLoading from './AdminLoading.jsx';
import { EffectStripPreview, effectThumbStyle, effectRedrawTarget } from './EffectStripPreview.jsx';
import { SpritePromptCell } from './SpritePromptCell.jsx';
import { effectRows, effectRowStatusLabel, previewSprite, effectSelectionEta, effectKey } from './effectSprites.js';
import { assetUrlVersioned } from './useTileSprites.js';
import {
  useActionCatalog, useBoxQueue, useSpriteConnectors, useSetBodyPlan, useDetectBodies, useApproveSpriteJobs, useClearConcepts, useClearSpriteJobs, useDeleteGenerated, useForceRegenerate, useHaltSpriteBatch, useQueueSprites, useRescueSpriteJobs, useRetryBoxCancel,
  SUBJECTS_KEY, useSpriteQueue, useSpriteSubjects, useStartSpriteBatch, useStopSpriteBatch,
  useEffectSprites, useQueueEffects, useApproveEffect, useResumeEffects, useRegeneratePrompt, useSavePrompt, useRevertPrompt,
} from './useSpriteConsole.js';
import {
  boxCancelLines, startBatchWarning, forceConfirmText, refusedLines, conceptImageOf, DEFAULT_DIRECTIONS, SPRITE_CELLS, DEFAULT_CELL, cellInfoLabel, DIRECTION_PRESETS, SPRITE_DIRECTIONS, directionsLabel, directionLossLines, hasWestern, presetOf, queueBlockReason, toggleDirection, deleteConfirmText, isPropSubject, newConceptConfirmText, nextConceptCaption, lastUpdateLabel, nextSpriteSort, sortSpriteSubjects, COLUMN_HELP, TABLE_SORT_HINT, TABLE_FILTER_HINT, NO_COLUMN_FILTERS, UPDATED_FILTERS, columnFilterChoices, actionTokens, directionTokens, backendTokens, targetsForSprites, defaultActionsFor, sheetImageOf, isBoxProp, methodOptionLabel, waitLabel, selectionCells, tookLabel, ESTIMATE_REUSE_HINT, WEST_MIRROR_HINT, batchProgress, batchHeadline, currentProgressLabel, rowProgressLabel, jobStateLabel, filterSpriteSubjects, framesCap, isSpritePageSelected, selectAllSpriteSubjects, setSpritePageSelected, spritePage,
  newCreatureBody, newCreatureError,
  selectionControls, queueRequests, effectFramesCap, effectPromptConflict, selectionBoxSeconds, selectionTotalEta, totalEtaLabel, forceKeepsConceptHint, spriteRowsOf, effectRowsOf,
  PROP_FX_OPTIONS, queueButtonLabel, queuePayload, queueIsLive, backendLabel, chosenConnector, chosenMethod, generationMethodsFor, selectionKinds, BODY_PLAN_OPTIONS, hasBodyPlan, bodyDetectIds, chunkIds, spriteShape, toggleSpriteSubject,
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
const Warning = styled(Hint)`color: var(--s2-warning);`;
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
const SortButton = styled.button`
  padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer;
  &:hover { color: var(--s2-text); }
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
const Muted = styled.span`color: var(--s2-text-muted); opacity: 0.7; font-style: italic;`;
const GroupCell = styled.td`background: var(--s2-bg-sunken); font-weight: 700;`;
const EffectThumb = styled.button`
  width: 38px; height: 38px; padding: 0; border: 1px solid var(--s2-border); border-radius: 4px; cursor: zoom-in;
  background-repeat: no-repeat; background-position: left center; image-rendering: pixelated;
`;

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
  const took = subject.job_state === 'done' ? tookLabel(subject) : null;
  const pill = <Pill>{rowProgressLabel(subject, run) || jobStateLabel(subject)}</Pill>;
  return took ? <>{pill} <Hint>{took}</Hint></> : pill;
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
// per direction. The box mirrors west rows, so ticking one says what that means.
// disabled (effects-only selection): shown greyed with the reason as its title.
export function DirectionsField({ directions, onChange, disabled = false, title = '' }) {
  const preset = presetOf(directions);
  return (
    <Field as="div" title={title || undefined} aria-disabled={disabled || undefined} style={disabled ? { opacity: 0.5 } : undefined}>
      {`Directions (${directions.length} of ${SPRITE_DIRECTIONS.length}) · ${preset ? `${preset}-way` : `custom (${directions.length})`}`}
      <ActionChips>
        {Object.keys(DIRECTION_PRESETS).map((n) => (
          <Secondary key={n} type="button" aria-pressed={preset === Number(n)} disabled={disabled}
            onClick={() => onChange([...DIRECTION_PRESETS[n]])}>{`${n}-way`}</Secondary>
        ))}
      </ActionChips>
      <ActionChips>
        {SPRITE_DIRECTIONS.map((id) => (
          <Check key={id}>
            <input type="checkbox" checked={directions.includes(id)} disabled={disabled}
              onChange={() => onChange(toggleDirection(directions, id))} />
            {id}
          </Check>
        ))}
      </ActionChips>
      <Hint>{WEST_MIRROR_HINT}</Hint>
      {hasWestern(directions) && (
        <Hint>West rows add no new view: the game draws the east row flipped. With no east row ticked, it flips the west row to face east.</Hint>
      )}
    </Field>
  );
}

const ARIA_SORT = { desc: 'descending', asc: 'ascending' };
const SORT_ARROW = { desc: ' ▼', asc: ' ▲' };

function SortHeader({ column, label, sort, onSort }) {
  const dir = sort?.column === column ? sort.dir : null;
  return (
    <th aria-sort={ARIA_SORT[dir] ?? 'none'}>
      <SortButton type="button" title={COLUMN_HELP[column]} onClick={() => onSort(column)}>{label}{SORT_ARROW[dir]}</SortButton>
    </th>
  );
}

// The filters for the table's columns. Options come from the rows themselves.
export function ColumnFilterFields({ subjects, filters, onChange }) {
  const tokenField = (key, label, tokensOf, order) => (
    <Field>{label}
      <select value={filters[key]} onChange={(event) => onChange(key, event.target.value)}>
        <option value="all">Any</option>
        <option value="none">None</option>
        {columnFilterChoices(subjects, tokensOf, filters[key], order).map((value) => (
          <option key={value} value={value}>{value}</option>
        ))}
      </select>
    </Field>
  );
  return (
    <>
      {tokenField('actions', 'Actions', actionTokens)}
      {tokenField('directions', 'Directions', directionTokens, SPRITE_DIRECTIONS)}
      <Field>Backend
        <select value={filters.backend} onChange={(event) => onChange('backend', event.target.value)}>
          <option value="all">Any</option>
          {columnFilterChoices(subjects, backendTokens, filters.backend).map((value) => (
            <option key={value} value={value}>{value}</option>
          ))}
        </select>
      </Field>
      <Field>Last update
        <select value={filters.updated} onChange={(event) => onChange('updated', event.target.value)}>
          {UPDATED_FILTERS.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
        </select>
      </Field>
    </>
  );
}

// An effect row's cells (spec §7): one strip in one direction on the box's effects lane.
function EffectCells({ subject, onPreview }) {
  const fx = subject.effect_subject || subject;
  const shown = previewSprite(fx);
  const status = effectRowStatusLabel(subject);
  const lastUpdate = lastUpdateLabel(subject.job_updated_at);
  return (
    <>
      <td>—</td>
      <td>{shown
        ? <EffectThumb type="button" aria-label={`Preview strip: ${subject.name}`} style={effectThumbStyle(shown, subject.blend)} onClick={() => onPreview(subject.id)} />
        : '—'}</td>
      <td>{subject.name}</td>
      <td>—</td>
      <td><Pill>effect</Pill></td>
      <td>{subject.loop ? 'loop' : 'one-shot'}</td>
      <td><Muted title="effects have one direction">one direction</Muted></td>
      <td>{subject.frames ?? '—'}</td>
      <td>gpu-box</td>
      <td>{subject.job_state === 'failed'
        ? <ErrorText title={subject.last_error || ''}>{status}</ErrorText>
        : <Pill>{status}</Pill>}</td>
      <td title={lastUpdate.title}>{lastUpdate.text}</td>
    </>
  );
}

const TABLE_COLUMNS = 13;

const loopSelectValue = (v) => (v === true ? 'loop' : v === false ? 'once' : '');

export function SpriteTable({ rows, selected, run, onToggle, onTogglePage, onPreview, sort = null, onSort, onBodyChange, promptPending = new Set(), onPromptRegenerate, onPromptSave, onPromptRevert }) {
  const headed = new Set();
  return (
    <TableWrap>
      <Table>
        <thead><tr>
          <th><input type="checkbox" aria-label="Select this page"
            checked={isSpritePageSelected(selected, rows)}
            onChange={(event) => onTogglePage(event.target.checked)} /></th>
          <th>Concept</th><th>Sheet / Result</th><th>Entity</th><th>Body</th>
          <SortHeader column="shape" label="Shape" sort={sort} onSort={onSort} />
          <SortHeader column="actions" label="Actions" sort={sort} onSort={onSort} />
          <SortHeader column="directions" label="Directions" sort={sort} onSort={onSort} />
          <th>Frames</th>
          <SortHeader column="backend" label="Backend" sort={sort} onSort={onSort} />
          <SortHeader column="status" label="Status" sort={sort} onSort={onSort} />
          <SortHeader column="updated" label="Last update" sort={sort} onSort={onSort} />
          <th>Prompt</th>
        </tr></thead>
        <tbody>
          {rows.map((subject) => {
            const promptCell = (
              <td><SpritePromptCell subject={subject} pending={promptPending.has(subject.id)}
                onRegenerate={() => onPromptRegenerate?.(subject)}
                onSave={(text) => onPromptSave?.(subject, text)}
                onRevert={() => onPromptRevert?.(subject)} /></td>
            );
            if (subject.effect) {
              // A group header above the first effect row of each group on this page.
              const header = !headed.has(subject.group);
              headed.add(subject.group);
              return (
                <Fragment key={subject.id}>
                  {header && <tr data-group-row><GroupCell colSpan={TABLE_COLUMNS}>{subject.group}</GroupCell></tr>}
                  <tr>
                    <td><input type="checkbox" aria-label={`Select ${subject.name}`} checked={selected.has(subject.id)}
                      onChange={() => onToggle(subject.id)} /></td>
                    <EffectCells subject={subject} onPreview={onPreview} />
                    {promptCell}
                  </tr>
                </Fragment>
              );
            }
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
                <td>{hasBodyPlan(subject) ? (
                  <select aria-label={`Body of ${subject.name}`} value={subject.body_plan || ''}
                    title={subject.body_plan_source === 'admin' ? 'Set by an admin' : subject.body_plan ? 'Picked by the text LLM from the name and prompt, so check it' : 'Not decided yet: drawn as two legs'}
                    onChange={(event) => onBodyChange?.(subject.id, event.target.value || null)}>
                    {BODY_PLAN_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : '—'}</td>
                <td><Pill>{spriteShape(subject)}</Pill></td>
                {/* A prop's queued actions mean nothing; actionTokens gives its effect instead. */}
                <td>{actionTokens(subject).join(' · ') || '—'}</td>
                <td>{directionsLabel(subject)}</td>
                <td>{subject.backend === 'gpu-box' && subject.frames_per_action
                  ? `${subject.frames_per_action} / action${cellInfoLabel(subject) ? ` · ${cellInfoLabel(subject)}` : ''}` : derivedFrames(subject)}</td>
                <td>{backendLabel(subject)}</td>
                <td><JobStatusCell subject={subject} run={run} /></td>
                <td title={lastUpdate.title}>{lastUpdate.text}</td>
                {promptCell}
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
  const headline = batchHeadline({ run, stats });
  const live = queueIsLive({ run, stats });
  const { subjects: spriteSubjects, isLoading, error } = useSpriteSubjects({ live });
  const { data: effectsData, eta: effectsEta, dispatcher: effectsDispatcher, error: effectsError } = useEffectSprites();
  // Effects share the table: API subjects first, then one row per effect.
  const subjects = useMemo(() => [...spriteSubjects, ...effectRows(effectsData)], [spriteSubjects, effectsData]);
  const [shape, setShape] = useState('all');
  const [status, setStatus] = useState('missing');
  const [search, setSearch] = useState('');
  const [columnFilters, setColumnFilters] = useState(NO_COLUMN_FILTERS);
  const [sort, setSort] = useState(null);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(new Set());
  const [previewId, setPreviewId] = useState(null);
  const { catalog, isLoading: catalogLoading, error: catalogError } = useActionCatalog();
  const { boxQueue } = useBoxQueue();
  const [chosenActions, setChosenActions] = useState(null);
  // SOMET-669: 4 frames per action by default (the default lane); `frames` below clamps it to the box's own cap.
  const [chosenFrames, setChosenFrames] = useState(4);
  // Props v2: the idle effect selected props get in game (prop_fx); '' lets the server pick per prop.
  const [propFx, setPropFx] = useState('');
  const [directions, setDirections] = useState(DEFAULT_DIRECTIONS);
  const [cellSize, setCellSize] = useState(DEFAULT_CELL);
  const [redrawActions, setRedrawActions] = useState(false);
  // The box's own frame checks (retry bad frames): slower and variable, so off unless ticked.
  const [qualityChecks, setQualityChecks] = useState(false);
  // Regenerate prompt: the text model writes a new prompt before drawing (off by default).
  const [regenerate, setRegenerate] = useState(false);
  // Effects-only selection: null = each effect's own default.
  const [effectFramesChoice, setEffectFramesChoice] = useState(null);
  const [effectLoopChoice, setEffectLoopChoice] = useState(null);
  // Effect prompts edited in this session (row id -> text): sent with Queue, refused with Regenerate.
  const [editedEffectPrompts, setEditedEffectPrompts] = useState({});
  // Rows whose per-row prompt action is in flight.
  const [promptPending, setPromptPending] = useState(() => new Set());
  // catalog.generation_methods id: a sampling preset plus how directions are drawn.
  const [methodId, setMethodId] = useState(null);
  const connectors = useSpriteConnectors();
  const [connectorId, setConnectorId] = useState(null);
  const connector = chosenConnector(connectors, connectorId);
  const methods = generationMethodsFor(catalog, connector?.engine);
  const method = chosenMethod(methods, methodId);
  const isHq = connector?.engine === 'comfyui-hq';
  const queue = useQueueSprites();
  const queueEffects = useQueueEffects();
  const approveEffect = useApproveEffect();
  const resumeEffects = useResumeEffects();
  const regeneratePrompt = useRegeneratePrompt();
  const savePrompt = useSavePrompt();
  const revertPrompt = useRevertPrompt();
  const forceRegenerate = useForceRegenerate();
  const setBody = useSetBodyPlan();
  const detect = useDetectBodies();
  const [detectProgress, setDetectProgress] = useState('');
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
    () => filterSpriteSubjects(subjects, { shape, status, search, ...columnFilters }),
    [subjects, shape, status, search, columnFilters],
  );
  const ordered = useMemo(() => sortSpriteSubjects(matching, sort), [matching, sort]);
  const shown = spritePage(ordered, page);
  // A filter change starts from page 1; page 4 of the old filter means nothing.
  const filter = (set) => (event) => { set(event.target.value); setPage(1); };
  // Same for a new order: page 3 of the old one holds unrelated rows.
  const cycleSort = (column) => { setSort((current) => nextSpriteSort(current, column)); setPage(1); };
  const setColumnFilter = (key, value) => { setColumnFilters((current) => ({ ...current, [key]: value })); setPage(1); };
  const selectedRows = subjects.filter((subject) => selected.has(subject.id));
  // Creature/prop rows go to POST /jobs, effect rows to the effects lane.
  const spriteRows = spriteRowsOf(selectedRows);
  const fxRows = effectRowsOf(selectedRows);
  const detectIds = bodyDetectIds(selectedRows, matching);
  const approvable = spriteRows.filter((subject) => subject.job_state === 'done' && subject.job_id);
  const fxApprovable = fxRows.filter((row) => row.job_id && effectRowStatusLabel(row) === 'ready to approve');

  // null = untouched, so the defaults follow the catalog once it loads and the
  // current selection; any explicit tick keeps the user's choice.
  const actions = chosenActions ?? defaultActionsFor(catalog, spriteRows);
  const cap = framesCap(catalog, actions);
  const frames = Math.min(chosenFrames, cap);
  const kinds = selectionKinds(selectedRows);
  const controls = selectionControls(selectedRows);
  const spriteOptions = { actions, frames, propFx, directions, cell: cellSize, redrawActions, sampling: method?.sampling ?? null, sheetMethod: method?.sheet_method ?? null, providerId: connectors.length > 1 && connector ? connector.id : null, qualityChecks: isHq ? null : qualityChecks, regenerate };
  const payload = queuePayload(catalog, spriteRows, spriteOptions);
  const fxCap = effectFramesCap(fxRows);
  const fxFrames = effectFramesChoice == null ? null : Math.min(effectFramesChoice, fxCap);
  const fxLoop = controls.effectLoop.locked ? null : effectLoopChoice;
  const requests = queueRequests(catalog, selectedRows, { ...spriteOptions, effectFrames: fxFrames, effectLoop: fxLoop, effectPrompts: editedEffectPrompts });
  const promptConflict = effectPromptConflict(fxRows, editedEffectPrompts, regenerate);
  // A running job keeps its options, so its cells are not this press's work.
  // The HQ connector has its own calibrated rate; other engines use the method's catalog rate.
  const etaSelection = {
    rows: spriteRows.filter((row) => row.job_state !== 'running'),
    actions: payload.actions, directions, frames: payload.frames,
    secondsPerCell: isHq ? connector.seconds_per_cell : undefined,
    engine: isHq ? 'comfyui-hq' : undefined,
    fallbackSecondsPerCell: connector?.seconds_per_cell || catalog?.seconds_per_cell,
  };
  const cells = selectionCells(etaSelection);
  // The whole press: creature sheets + effect strips + the prompt phase when Regenerate is ticked.
  const fxWaiting = fxRows.filter((row) => row.job_state !== 'running');
  const creatureBox = selectionBoxSeconds(method, etaSelection, catalog?.eta_model, isHq || qualityChecks);
  const totalEta = selectionTotalEta({
    boxSeconds: creatureBox,
    effectEta: fxWaiting.length ? effectSelectionEta(fxWaiting, new Set(fxWaiting.map(effectKey)), effectsEta) : null,
    prompts: {
      sprite: regenerate ? etaSelection.rows.filter((row) => spriteShape(row) === 'directional').length : 0,
      effect: regenerate ? fxWaiting.length : 0,
    },
    promptEta: boxQueue?.prompt_eta ?? null,
  });
  const etaText = `${totalEtaLabel(totalEta)}${kinds.creatures && !creatureBox ? ' · creatures: no time estimate' : ''}`;
  const toggleAction = (id) => setChosenActions(
    actions.includes(id) ? actions.filter((a) => a !== id) : [...actions, id],
  );
  const catalogReady = Boolean(catalog) && !catalogLoading && !catalogError;
  const queueButton = queueButtonLabel(selectedRows);
  const blockReason = queueBlockReason(spriteRows, directions, { sheetMethod: method?.sheet_method, actions }) || promptConflict;
  const lossLines = directionLossLines(spriteRows, directions);
  // Effects need no catalog: an effects-only press only checks the button.
  const spriteSideOk = spriteRows.length === 0 || (catalogReady && payload.actions.length > 0);
  const queueable = requests.length > 0 && queueButton.actionable && spriteSideOk && !blockReason;
  const canQueue = queueable && !queue.isPending && !queueEffects.isPending;
  const forceHint = forceKeepsConceptHint(spriteRows);
  const anyFxQueued = subjects.some((row) => row.effect && row.job_state === 'queued');

  const submitNewCreature = (event) => {
    event.preventDefault();
    const problem = newCreatureError(newForm.name);
    if (problem) { setNewForm((f) => ({ ...f, error: problem })); return; }
    setNewForm((f) => ({ ...f, error: null }));
    createEntity.mutate(newCreatureBody(newForm), {
      onSuccess: (created) => {
        const name = created?.name ?? newForm.name.trim();
        qc.invalidateQueries({ queryKey: SUBJECTS_KEY });
        setSearch(name); setStatus('all'); setShape('all'); setColumnFilters(NO_COLUMN_FILTERS); setPage(1);
        setSelected(new Set([created.id]));
        setNewForm({ open: false, name: '', prompt: '', shape: 'creature', error: null });
        setCreatedNote(`Created ${name} — ready to queue.`);
      },
      onError: (err) => setNewForm((f) => ({ ...f, error: err.message })),
    });
  };

  // One press, both lanes; the selection clears only when every request succeeded
  // (each failure is already a toast).
  const enqueue = async () => {
    const queuedFx = fxRows.map((row) => row.id);
    const results = await Promise.allSettled(requests.map((r) => (r.path === '/jobs' ? queue : queueEffects).mutateAsync(r.body)));
    if (results.every((r) => r.status === 'fulfilled')) {
      setSelected(new Set());
      setEditedEffectPrompts((cur) => Object.fromEntries(Object.entries(cur).filter(([id]) => !queuedFx.includes(id))));
    }
  };
  const forceable = catalogReady && spriteRows.length > 0 && payload.actions.length > 0 && !queueBlockReason(spriteRows, directions, { sheetMethod: method?.sheet_method, actions })
    && !forceRegenerate.isPending;
  const forceSelected = () => {
    if (!window.confirm(forceConfirmText(spriteRows.length))) return;
    const rows = spriteRows;
    setForceRefused(null);
    forceRegenerate.mutate(payload, {
      onSuccess: (data) => {
        const next = new Set();
        setSelected(next);
        setForceRefused({ lines: refusedLines(data.refused, rows), selection: next });
      },
    });
  };
  const approveCount = approvable.length + fxApprovable.length;
  const approveSelected = async () => {
    const tasks = [];
    if (approvable.length) tasks.push(approve.mutateAsync(approvable.map((subject) => subject.job_id)));
    for (const row of fxApprovable) tasks.push(approveEffect.mutateAsync({ id: row.job_id }));
    const results = await Promise.allSettled(tasks);
    if (results.every((r) => r.status === 'fulfilled')) setSelected(new Set());
  };

  // Per-row prompt actions. A 409 (already regenerating / text model busy) is a toast from the hook.
  const promptTarget = (row) => ({ kind: row.prompt_kind, key: row.prompt_key });
  const dropEdited = (row) => setEditedEffectPrompts((cur) => {
    if (!(row.id in cur)) return cur;
    const next = { ...cur };
    delete next[row.id];
    return next;
  });
  const withPending = (row, run) => {
    setPromptPending((cur) => new Set(cur).add(row.id));
    run().catch(() => {}).finally(() => setPromptPending((cur) => {
      const next = new Set(cur);
      next.delete(row.id);
      return next;
    }));
  };
  const regenerateRowPrompt = (row) => withPending(row, () => regeneratePrompt.mutateAsync(promptTarget(row)).then(() => dropEdited(row)));
  const saveRowPrompt = (row, text) => withPending(row, () => savePrompt.mutateAsync({ ...promptTarget(row), text })
    .then(() => { if (row.effect) setEditedEffectPrompts((cur) => ({ ...cur, [row.id]: text })); }));
  const revertRowPrompt = (row) => withPending(row, () => revertPrompt.mutateAsync(promptTarget(row)).then(() => dropEdited(row)));

  const deleteSelected = () => confirmAndDelete(
    (text) => window.confirm(text),
    (body) => deleteGenerated.mutate(body, { onSuccess: () => setSelected(new Set()) }),
    spriteRows,
  );
  const clearSelectedConcepts = () => confirmAndClearConcepts(
    (text) => window.confirm(text),
    (body) => clearConcepts.mutate(body),
    spriteRows,
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
        <strong>{headline.title}</strong>
        <Hint>
          {stats.queued || 0} queued · {stats.running || 0} running · {stats.done || 0} ready for review
          {' · '}{stats.failed || 0} failed · {stats.approved || 0} approved
        </Hint>
        {headline.hint && <Hint>{headline.hint}</Hint>}
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
            <option value="effect">Effects</option>
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
            <option value="none">Not queued</option>
            <option value="all">Any</option>
          </select>
        </Field>
        <ColumnFilterFields subjects={subjects} filters={columnFilters} onChange={setColumnFilter} />
        <Field>Search
          <input value={search} onChange={filter(setSearch)} placeholder="entity name" />
        </Field>
      </Bar>
      <Hint>{TABLE_FILTER_HINT}</Hint>

      <Bar>
        {/* Actions and frames shape a creature's sheet; a prop is one image
            with an idle effect, so a props-only selection hides them. */}
        {kinds.propsOnly ? (
          <Hint>Props are one image each: actions and frames do not apply.</Hint>
        ) : (
          <>
            {controls.creatureActions && (<Field as="div">
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
            </Field>)}
            <DirectionsField directions={directions} onChange={setDirections}
              disabled={controls.facings.disabled} title={controls.facings.title} />
            {controls.creatureActions && (<Field>Frames
              <select value={frames} disabled={!catalogReady}
                onChange={(event) => setChosenFrames(Number(event.target.value))}>
                {Array.from({ length: cap }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </Field>)}
            <Field title={controls.cell.title || undefined}>Cell size
              <select value={cellSize} disabled={controls.cell.disabled} onChange={(event) => setCellSize(event.target.value)}>
                {SPRITE_CELLS.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            </Field>
            {controls.creatureActions && connectors.length > 1 && (
              <Field>Connector
                <select value={connector ? connector.id : ''} onChange={(event) => setConnectorId(Number(event.target.value))}>
                  {connectors.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}{c.engine === 'comfyui-hq' ? ' (HQ, experimental)' : ''}</option>
                  ))}
                </select>
              </Field>
            )}
            {controls.creatureActions && methods.length > 1 && (
              <Field title="How the box draws the sheet. Larger than VRAM spills to system RAM and is much slower; 3D builds the 2D sheet first, then replaces its idle frames">Generation method
                <select value={method?.id ?? ''} onChange={(event) => setMethodId(event.target.value)}>
                  {methods.map((m) => (
                    <option key={m.id} value={m.id}>{methodOptionLabel(m, etaSelection, catalog?.eta_model, isHq || qualityChecks)}</option>
                  ))}
                </select>
              </Field>
            )}
            {controls.creatureActions && !isHq && (
              <Check title="The box re-draws frames its own checks reject. Off: one pass, predictable time. On: extra rounds, time varies">
                <input type="checkbox" checked={qualityChecks}
                  onChange={(event) => setQualityChecks(event.target.checked)} />
                Auto-fix bad frames (slower, time varies)
              </Check>
            )}
            {controls.creatureActions && (
              <Check title="Draw the ticked actions again even if the sheet already has them; the sheet's other actions are kept">
                <input type="checkbox" checked={redrawActions}
                  onChange={(event) => setRedrawActions(event.target.checked)} />
                Redraw selected actions
              </Check>
            )}
          </>
        )}
        {/* Outside the creature fragment so an effects-only selection has it too. Props have no prompt lane. */}
        {!kinds.propsOnly && (
          <Check title="The text model writes a new prompt for each selected creature, hero and effect before it is drawn, and a creature draws a fresh concept. Props are not affected">
            <input type="checkbox" checked={regenerate} onChange={(event) => setRegenerate(event.target.checked)} />
            Regenerate prompt
          </Check>
        )}
        {controls.effectFrames && (
          <Field>Effect frames
            <select aria-label="Effect frames" value={fxFrames ?? ''}
              onChange={(event) => setEffectFramesChoice(event.target.value === '' ? null : Number(event.target.value))}>
              <option value="">Default per effect</option>
              {Array.from({ length: fxCap }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </Field>
        )}
        {controls.effectLoop.shown && (
          <Field title={controls.effectLoop.title || undefined}>Loop
            <select aria-label="Effect loop" disabled={controls.effectLoop.locked}
              value={loopSelectValue(controls.effectLoop.locked ? controls.effectLoop.value : effectLoopChoice)}
              onChange={(event) => setEffectLoopChoice(event.target.value === '' ? null : event.target.value === 'loop')}>
              <option value="">Default per effect</option>
              <option value="loop">Loop</option>
              <option value="once">One-shot</option>
            </select>
          </Field>
        )}
        {kinds.props && (
          <Field>Prop effect
            <select value={propFx} onChange={(event) => setPropFx(event.target.value)}>
              <option value="">Auto (trees Drift, others None)</option>
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
          Force regenerate {spriteRows.length} selected
        </Secondary>
        {forceHint && <Hint role="status">{forceHint}</Hint>}
        {blockReason && <Hint>{blockReason}</Hint>}
        {lossLines.map((line) => <Warning key={line} role="status">{line}</Warning>)}
        {(forceRefused && forceRefused.selection === selected ? forceRefused.lines : []).map((line) => <Hint key={line} role="status">Not regenerated — {line}</Hint>)}
        {queueable && (
          <>
            <Hint>{spriteRows.length ? `${cells} cell${cells === 1 ? '' : 's'} · ${etaText}` : etaText}</Hint>
            <Hint>{waitLabel(boxQueue)}</Hint>
            {spriteRows.length > 0 && <Hint>{ESTIMATE_REUSE_HINT}</Hint>}
          </>
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
        {anyFxQueued && effectsDispatcher && !effectsDispatcher.running && (
          <Secondary disabled={resumeEffects.isPending} onClick={() => resumeEffects.mutate()}>Resume effects queue</Secondary>
        )}
        <ConceptButtons count={spriteRows.length} deletePending={deleteGenerated.isPending}
          clearPending={clearConcepts.isPending} onDelete={deleteSelected} onClear={clearSelectedConcepts} />
        <Button disabled={approveCount === 0 || approve.isPending || approveEffect.isPending} onClick={approveSelected}>
          Approve {approveCount} completed
        </Button>
      </Bar>

      <Hint>{matching.length} matching · {selected.size} selected</Hint>
      <Bar>
        <Secondary disabled={detect.isPending || run?.running || detectIds.length === 0}
          title="The text LLM picks a body from each creature's name and prompt. It can guess wrong, so check the Body column. Choices you set yourself are kept."
          onClick={() => detect.mutate({ chunks: chunkIds(detectIds), onProgress: (done, total) => setDetectProgress(`${done} of ${total} groups`) })}>
          {detect.isPending ? `Detecting… ${detectProgress}` : `Detect body for ${detectIds.length}`}
        </Secondary>
        <Hint>Four legs: Cast Spell and Use are skipped for those creatures.</Hint>
      </Bar>
      {effectsError && <Hint role="alert">Effects: {effectsError.message}</Hint>}
      {pager}
      <Hint>{TABLE_SORT_HINT}</Hint>
      <SpriteTable rows={shown.rows} selected={selected} run={run}
        onToggle={(id) => setSelected(toggleSpriteSubject(selected, id))}
        onTogglePage={(on) => setSelected(setSpritePageSelected(selected, shown.rows, on))}
        onPreview={setPreviewId}
        onBodyChange={(id, bodyPlan) => setBody.mutate({ id, body_plan: bodyPlan })}
        promptPending={promptPending} onPromptRegenerate={regenerateRowPrompt}
        onPromptSave={saveRowPrompt} onPromptRevert={revertRowPrompt}
        sort={sort} onSort={cycleSort} />
      {pager}
      {previewSubject?.effect && (
        <EffectStripPreview subject={previewSubject.effect_subject} onClose={() => setPreviewId(null)}
          pending={queueEffects.isPending || approveEffect.isPending}
          onRedraw={() => queueEffects.mutate({ targets: [effectRedrawTarget(previewSubject.effect_subject)] })}
          onApprove={() => approveEffect.mutate({ id: previewSubject.job_id })} />
      )}
      {previewSubject && !previewSubject.effect && <SpritePreviewModal subject={previewSubject} onClose={() => setPreviewId(null)} />}
    </Wrap>
  );
}

export default SpriteConsoleAdmin;
