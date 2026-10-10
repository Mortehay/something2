// The Audio tab's Subjects view (SOMET-596): one row per (kind, key, slot) in
// a filterable, paged table, a "Queue N selected" bar, and a failed-by-cause
// retry panel -- the Art Generation tab's pattern (ArtConsoleAdmin.jsx +
// artSelection.js), applied to audio slots. Clicking a row opens that
// subject's existing slot cards (SubjectSounds) in the right column, so
// single Generate/Upload/Loop/library/volume are unchanged.
//
// Every rule lives in audioSelection.js and is unit-tested there; this file
// renders what it returns. The data (subjects, misses, slot jobs) is fetched
// by AudioAdmin, which stays mounted across the Subjects/Library switch and
// owns the post-drain refresh.
import {
  useEffect, useMemo, useRef, useState,
} from 'react';
import toast from 'react-hot-toast';
import { useSearchParams } from 'react-router-dom';
import styled from 'styled-components';
import { useEnqueueAudioJobs, useRetryAudioFailures } from './useAudioAdmin.js';
import { uploadOnlySlotIds } from './audioBatch.js';
import {
  audioSlotRows, jobsBySlotFrom, missesSetFrom, applyFilters, filtersFromParams, paramsFromFilters,
  PAGE_SIZE, pageCount, clampPage, toggle, selectPage, deselectPage, isPageFullySelected,
  selectAllMatching, selectionOutsideFilter, queueItems, enqueueSummary, failedByCause, soundText,
  jobsForKnownSubjects, uploadOnlyCount, slotId,
  DEFAULT_SFX_VARIANTS, MAX_SFX_VARIANTS, createSearchSync, singleFlight, parseVariants,
} from './audioSelection.js';
import SubjectSounds from './SubjectSounds.jsx';

const Bar = styled.div`
  display: flex; gap: 0.75rem; flex-wrap: wrap; align-items: flex-end; margin-bottom: 0.75rem;
`;
// A checkbox beside the queue controls: Field's column layout and 140px
// input width are for selects and text inputs.
const CheckLabel = styled.label`
  display: flex; align-items: center; gap: 0.35rem; font-size: 0.8rem;
  color: var(--s2-text-muted); padding-bottom: 0.45rem;
`;
const Field = styled.label`
  display: flex; flex-direction: column; gap: 0.25rem;
  font-size: 0.8rem; color: var(--s2-text-muted);
  input, select {
    background: var(--s2-bg-sunken); color: var(--s2-text);
    border: 1px solid var(--s2-border-strong); border-radius: 4px;
    padding: 0.4rem; min-width: 140px; font-size: 0.9rem;
  }
`;
const Button = styled.button`
  background: var(--s2-accent); color: var(--s2-on-accent); border: none; border-radius: 6px;
  padding: 0.4rem 0.9rem; font-weight: bold; cursor: pointer; font-size: 0.85rem;
  &:disabled { opacity: 0.5; cursor: default; }
`;
const Secondary = styled(Button)`background: var(--s2-btn-grey);`;
// Field's 140px min-width is for selects and text; a 1-5 number needs less.
const VariantsField = styled(Field)`input { min-width: 0; width: 4rem; }`;
const Hint = styled.p`color: var(--s2-text-muted); font-size: 0.85rem; margin: 0.25rem 0;`;
const Err = styled.p`color: var(--s2-danger); font-size: 0.85rem; margin: 0.25rem 0;`;
const LinkButton = styled.button`
  background: none; border: none; color: var(--s2-accent); cursor: pointer; padding: 0;
  font: inherit; text-decoration: underline;
`;
const Columns = styled.div`
  display: grid; grid-template-columns: minmax(0, 1fr) 24rem; gap: 1.25rem; align-items: start;
  @media (max-width: 1100px) { grid-template-columns: 1fr; }
`;
const Right = styled.div`min-width: 0;`;
const Pager = styled.div`display: flex; gap: 0.5rem; align-items: center; margin: 0.75rem 0; font-size: 0.85rem;`;
const TableWrap = styled.div`
  border: 1px solid var(--s2-border); border-radius: 8px;
  background: var(--s2-surface-raised); overflow-x: auto;
`;
const Table = styled.table`
  width: 100%; border-collapse: collapse; font-size: 0.85rem;
  th, td { text-align: left; padding: 0.35rem 0.6rem; border-bottom: 1px solid var(--s2-border); }
  th { color: var(--s2-text-muted); font-weight: normal; }
  tbody tr { cursor: pointer; }
  tbody tr:hover { background: var(--s2-overlay); }
  tbody tr[data-active='true'] { background: var(--s2-overlay); }
`;
const Mono = styled.td`font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all;`;
const SubjectButton = styled.button`
  background: none; border: none; padding: 0; cursor: pointer; text-align: left;
  color: var(--s2-text); font: inherit; text-decoration: underline dotted;
  &:focus-visible { outline: 2px solid var(--s2-accent); outline-offset: 2px; }
`;
const Pill = styled.span`
  font-size: 0.75rem; padding: 0.1rem 0.4rem; border-radius: 999px;
  background: var(--s2-bg-sunken); color: var(--s2-text-muted); white-space: nowrap;
`;
const Fail = styled(Pill)`color: var(--s2-danger);`;
const ErrText = styled.span`
  display: block; font-size: 0.75rem; color: var(--s2-text-muted); margin-top: 0.15rem;
  max-width: 22rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
`;
const Failures = styled.section`
  border: 1px solid var(--s2-border); border-radius: 8px;
  background: var(--s2-surface-raised); padding: 0.75rem 1rem; margin: 0.75rem 0;
`;
const FailGroup = styled.div`
  & + & { border-top: 1px solid var(--s2-border); margin-top: 0.75rem; padding-top: 0.75rem; }
  h4 { margin: 0 0 0.2rem; font-size: 0.95rem; color: var(--s2-text); }
  code {
    display: block; font-size: 0.75rem; color: var(--s2-text-dim);
    background: var(--s2-bg-sunken); border-radius: 4px; padding: 0.35rem 0.5rem; margin: 0.25rem 0;
    white-space: pre-wrap; word-break: break-word;
  }
`;
const Samples = styled.p`
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.75rem; color: var(--s2-text-muted); margin: 0 0 0.4rem; word-break: break-all;
`;

const SFX_ENGINES = [['realistic', 'Realistic'], ['retro', 'Retro']];
// Same tooltip as AudioSlotCard's Suggest/Generate and AudioBatchPanel's
// Start, so a disabled generation control reads the same everywhere.
const NO_PROVIDER_TITLE = 'No audio provider — add one under AI Providers';
const UPLOAD_ONLY_TITLE = 'Upload only — the provider has no cue for this slot';
const ERROR_PREVIEW = 80;

function JobCell({ job }) {
  if (!job) return <td />;
  if (job.status !== 'failed') return <td><Pill>{job.status}</Pill></td>;
  const text = job.error || '';
  return (
    <td>
      <Fail>failed</Fail>
      {text && (
        <ErrText title={text}>
          {text.length > ERROR_PREVIEW ? `${text.slice(0, ERROR_PREVIEW)}…` : text}
        </ErrText>
      )}
    </td>
  );
}

function AudioSlotTable({
  subjects, misses, slotJobs, canGenerate, styleNames,
}) {
  const enqueue = useEnqueueAudioJobs();
  const retry = useRetryAudioFailures();

  // The filters ARE the URL (`?kind=&sound=&q=`): read from it every render
  // and written back on change, so a reload or a shared link lands on the
  // same table. A kind the registry does not list is read as "all".
  const [searchParams, setSearchParams] = useSearchParams();
  const kindKeys = useMemo(() => (subjects || []).map((g) => g.kind), [subjects]);
  const {
    kind, sound, search, prompt,
  } = filtersFromParams(searchParams, kindKeys);
  const [page, setPage] = useState(1);
  // The params a filter change builds on. react-router's functional
  // setSearchParams form still hands the updater THIS render's params, so two
  // changes in one tick would clobber each other (seen in the browser); this
  // ref carries the pending value between them. Re-synced from the URL on
  // every render (and so on back/forward).
  const pendingParams = useRef(searchParams);
  useEffect(() => { pendingParams.current = searchParams; }, [searchParams]);
  const setFilter = (patch) => {
    const next = paramsFromFilters({ ...filtersFromParams(pendingParams.current, kindKeys), ...patch });
    pendingParams.current = next;
    setSearchParams(next, { replace: true });
    setPage(1);
  };

  // The Search box shows its OWN text and reaches `?q=` after a pause
  // (createSearchSync): bound straight to the URL it lost keystrokes, since
  // each commit re-filters every row. setFilter is re-created every render,
  // so the debounced commit calls the latest one through a ref.
  const [searchText, setSearchText] = useState(search);
  const setFilterRef = useRef(setFilter);
  setFilterRef.current = setFilter;
  const [searchSync] = useState(() => createSearchSync(
    (v) => setFilterRef.current({ search: v }), undefined, search,
  ));
  useEffect(() => {
    const v = searchSync.fromUrl(search);
    if (v !== null) setSearchText(v);
  }, [search, searchSync]);
  useEffect(() => () => searchSync.cancel(), [searchSync]);

  const [selected, setSelected] = useState(() => new Set());
  const [subject, setSubject] = useState(null);
  const [style, setStyle] = useState('');
  const [engine, setEngine] = useState('realistic');
  // The Variants box keeps its raw text so it can be cleared and retyped;
  // `variants` is the last valid count, which a blur restores the box to.
  const [variantsText, setVariantsText] = useState(String(DEFAULT_SFX_VARIANTS));
  const [variants, setVariants] = useState(DEFAULT_SFX_VARIANTS);
  // Plan 2026-10-03: off by default -- a forced prompt replaces even a
  // hand-written one (the old version stays in the slot's history).
  const [forcePrompt, setForcePrompt] = useState(false);
  const [notice, setNotice] = useState(null);
  const [failure, setFailure] = useState(null);

  // Jobs for subjects that no longer exist are left out everywhere: such a
  // job can never succeed, so it has no row and no "Retry these N".
  const knownJobs = useMemo(() => jobsForKnownSubjects(slotJobs, subjects), [slotJobs, subjects]);
  const rows = useMemo(() => audioSlotRows(
    subjects, jobsBySlotFrom(knownJobs), missesSetFrom(misses), uploadOnlySlotIds(subjects),
  ), [subjects, knownJobs, misses]);
  const rowsById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const kinds = useMemo(() => (subjects || []).map((g) => [g.kind, g.label || g.kind]), [subjects]);
  const matching = useMemo(
    () => applyFilters(rows, {
      kind, sound, search, prompt,
    }),
    [rows, kind, sound, search, prompt],
  );
  const causes = useMemo(() => failedByCause(knownJobs), [knownJobs]);
  // One retry at a time: disabled={retry.isPending} lands a render late, and
  // a fast double-click sent two POSTs.
  // The mutation's own onError toasts a failure, so the rejection is dropped.
  const retryRef = useRef(retry);
  retryRef.current = retry;
  const [retryOnce] = useState(() => singleFlight((ids) => retryRef.current.mutateAsync(ids).catch(() => {})));

  const shownPage = clampPage(page, matching.length);
  const pages = pageCount(matching.length);
  // Upload-only rows match "missing" but are never selectable, so "N
  // matching" and "Select all M matching" differ by exactly this.
  const uploadOnlyMatching = uploadOnlyCount(matching);
  const pageRows = matching.slice((shownPage - 1) * PAGE_SIZE, shownPage * PAGE_SIZE);
  const hiddenSelected = selectionOutsideFilter(selected, matching);
  const allMatching = selectAllMatching(matching);

  const selectedGroup = subject && (subjects || []).find((g) => g.kind === subject.kind);

  // Rendered above AND below the table, as on the Art tab: at 100 rows the
  // bottom copy is far down the page.
  const pager = (
    <Pager>
      <Secondary type="button" onClick={() => setPage(shownPage - 1)} disabled={shownPage <= 1}>Prev</Secondary>
      <span>
        Page {shownPage} of {pages} · {matching.length} matching
        {uploadOnlyMatching > 0 && ` (${uploadOnlyMatching} upload-only)`}
      </span>
      <Secondary type="button" onClick={() => setPage(shownPage + 1)} disabled={shownPage >= pages}>Next</Secondary>
    </Pager>
  );

  const onQueue = async () => {
    const variantsNow = parseVariants(variantsText);
    if (variantsNow === null) {
      setNotice(null);
      setFailure(`Variants must be a whole number from 1 to ${MAX_SFX_VARIANTS}.`);
      return;
    }
    const { items, skipped } = queueItems(selected, rowsById, {
      style, engine, forcePrompt, variants: variantsNow,
    });
    setFailure(null);
    if (items.length === 0) {
      setNotice(enqueueSummary([], skipped).message);
      return;
    }
    try {
      // Sent in chunks of the route's cap; a failed chunk stops the rest.
      const out = await enqueue.mutateAsync({ items });
      const summary = enqueueSummary(out.results, skipped, out.error);
      if (out.error) {
        // Keep exactly what was not sent selected, so Queue can be pressed
        // again once the cause is fixed.
        setSelected(new Set(out.unsent.map((it) => slotId(it.subject_kind, it.subject_key, it.slot))));
        setNotice(null);
        setFailure(summary.message);
        toast.error(summary.message);
      } else {
        setSelected(new Set());
        setFailure(null);
        setNotice(summary.message);
        toast.success(summary.message);
      }
    } catch (err) {
      setNotice(null);
      setFailure(err.message);
    }
  };

  return (
    <>
      <Bar>
        <Field>
          Kind
          <select value={kind} onChange={(e) => setFilter({ kind: e.target.value })}>
            <option value="all">All kinds</option>
            {kinds.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </Field>
        <Field>
          Sound
          <select value={sound} onChange={(e) => setFilter({ sound: e.target.value })}>
            <option value="missing">Missing</option>
            <option value="has">Has sound</option>
            <option value="reported">Reported missing in game</option>
            <option value="failed">Last job failed</option>
            <option value="all">Any</option>
          </select>
        </Field>
        <Field>
          Search
          <input
            value={searchText}
            onChange={(e) => { setSearchText(e.target.value); searchSync.type(e.target.value); }}
            placeholder="subject or slot"
          />
        </Field>
        <Field>
          Prompt
          <select value={prompt} aria-label="Prompt filter" onChange={(e) => setFilter({ prompt: e.target.value })}>
            <option value="all">Any prompt</option>
            <option value="none">No prompt</option>
            <option value="written">Written (current)</option>
            <option value="stale">Stale prompt</option>
          </select>
        </Field>
      </Bar>

      <Bar>
        <Field>
          Style (music/ambience)
          <select value={style} onChange={(e) => setStyle(e.target.value)}>
            <option value="">Suggest per subject</option>
            {(styleNames || []).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </Field>
        <Field>
          Engine (sfx)
          <select value={engine} onChange={(e) => setEngine(e.target.value)}>
            {SFX_ENGINES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </Field>
        <VariantsField title="How many takes each queued sfx slot generates">
          Variants (sfx)
          <input
            type="number"
            min={1}
            max={MAX_SFX_VARIANTS}
            value={variantsText}
            onChange={(e) => {
              setVariantsText(e.target.value);
              const n = parseVariants(e.target.value);
              if (n !== null) setVariants(n);
            }}
            onBlur={() => setVariantsText(String(variants))}
          />
        </VariantsField>
        <CheckLabel title="Write a new prompt for every queued slot, even one that already has a prompt (hand-written included). The old prompt stays in the slot's history.">
          <input
            type="checkbox"
            checked={forcePrompt}
            aria-label="Force regenerate prompt"
            onChange={(e) => setForcePrompt(e.target.checked)}
          />
          Force regenerate prompt
        </CheckLabel>
        <Button
          type="button"
          onClick={onQueue}
          disabled={selected.size === 0 || enqueue.isPending || !canGenerate}
          title={canGenerate ? undefined : NO_PROVIDER_TITLE}
        >
          {enqueue.isPending ? 'Queuing…' : `Queue ${selected.size} selected`}
        </Button>
        {allMatching.size > 0 && (
          <Secondary type="button" onClick={() => setSelected(allMatching)}>
            Select all {allMatching.size} matching
          </Secondary>
        )}
        {selected.size > 0 && (
          <Secondary type="button" onClick={() => setSelected(new Set())}>Clear selection</Secondary>
        )}
      </Bar>

      {hiddenSelected > 0 && (
        <Hint>
          {hiddenSelected} selected {hiddenSelected === 1 ? 'is' : 'are'} hidden by the current filter.{' '}
          <LinkButton type="button" onClick={() => setSelected(new Set())}>Clear selection</LinkButton>
        </Hint>
      )}
      {notice && <Hint>{notice}</Hint>}
      {failure && <Err>{failure}</Err>}

      {causes.length > 0 && (
        <Failures>
          <strong>Failed slots, by cause</strong>
          {causes.map((g) => (
            <FailGroup key={g.cause}>
              <h4>{g.count} failed</h4>
              {/* The provider's own words, not only the normalized cause. */}
              <code>{String(g.text || g.cause).slice(0, 400)}</code>
              <Samples>
                {g.samples.join(', ')}
                {g.more > 0 && ` … and ${g.more} more`}
              </Samples>
              <Secondary type="button" disabled={retry.isPending} onClick={() => retryOnce(g.ids)}>
                Retry these {g.count}
              </Secondary>
            </FailGroup>
          ))}
        </Failures>
      )}

      <Columns>
        <div>
          {pager}
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label="Select this page"
                      checked={isPageFullySelected(selected, pageRows)}
                      onChange={(e) => setSelected(
                        e.target.checked ? selectPage(selected, pageRows) : deselectPage(selected, pageRows),
                      )}
                    />
                  </th>
                  <th>Kind</th><th>Subject</th><th>Slot</th><th>Sound</th><th>Prompt</th><th>Job</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r, i) => {
                  const soundId = `audio-slot-sound-${shownPage}-${i}`;
                  const active = Boolean(subject) && subject.kind === r.kind && subject.key === r.key;
                  return (
                    <tr
                      key={r.id}
                      data-active={active ? 'true' : 'false'}
                      onClick={() => setSubject({ kind: r.kind, key: r.key })}
                    >
                      {/* The checkbox cell swallows its click, so ticking a row
                          never also opens its slot cards. */}
                      <td onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${r.id}`}
                          disabled={r.uploadOnly}
                          title={r.uploadOnly ? UPLOAD_ONLY_TITLE : undefined}
                          // A disabled input's title is often neither shown
                          // nor announced; point at the visible reason.
                          aria-describedby={r.uploadOnly ? soundId : undefined}
                          checked={selected.has(r.id)}
                          onChange={() => setSelected(toggle(selected, r.id))}
                        />
                      </td>
                      <td><Pill>{r.kindLabel}</Pill></td>
                      <Mono>
                        {/* A real button, so a keyboard user can open the
                            slot cards too; the row's own click is the
                            mouse shortcut for the same thing. */}
                        <SubjectButton
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setSubject({ kind: r.kind, key: r.key }); }}
                        >
                          {r.key}
                        </SubjectButton>
                      </Mono>
                      <td>{r.slot}</td>
                      <td title={r.uploadOnly && r.clips === 0 ? UPLOAD_ONLY_TITLE : undefined}>
                        <span id={soundId}>{soundText(r)}</span>
                        {r.reported && <Pill title="The game reported this sound missing"> reported</Pill>}
                      </td>
                      <td>{r.prompt === 'none' || r.prompt === 'cleared' ? '—' : r.prompt}</td>
                      <JobCell job={r.job} />
                    </tr>
                  );
                })}
                {pageRows.length === 0 && (
                  <tr><td colSpan={7}><Hint>Nothing matches this filter.</Hint></td></tr>
                )}
              </tbody>
            </Table>
          </TableWrap>
          {pager}
        </div>

        <Right>
          {!subject && <Hint>Click a row to edit that subject's sounds.</Hint>}
          {subject && (
            <>
              <h3>{selectedGroup ? selectedGroup.label : subject.kind} · {subject.key}</h3>
              <SubjectSounds kind={subject.kind} subjectKey={subject.key} canGenerate={canGenerate} />
            </>
          )}
        </Right>
      </Columns>
    </>
  );
}

export default AudioSlotTable;
