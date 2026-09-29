// The Audio admin tab (SOMET-590/591, game audio slices 1-2): worlds and
// biomes today, more subject kinds arrive in later slices as
// audioSubjects.js grows.
//
// Two tabs: Subjects (the subject tree + per-slot editing, with an optional
// Batch mode overlay for queuing many jobs at once) and Library (every
// stored clip, independent of any subject). Subjects tab's left column is
// the subject tree (with a filled/total badge per subject) and the
// missing-sounds to-do list; the right column is either the selected
// subject's slot cards or (in Batch mode) the batch queue controls.
//
// EVERY RULE about what a slot accepts lives on the backend (audioSubjects.js,
// audioLibrary.js) -- this file and its slot cards render what the registry
// and the bindings say, the same split ArtConsoleAdmin uses against
// artSelection.js. audioBatch.js is that split's counterpart for batch
// selection/progress arithmetic.
import {
  useEffect, useMemo, useRef, useState,
} from 'react';
import { Link } from 'react-router-dom';
import styled from 'styled-components';
import { useQueryClient } from '@tanstack/react-query';
import {
  useAudioSubjects, useAudioMisses, slotRows,
  useAudioJobs, SUBJECTS_KEY, MISSES_KEY, ALL_SLOTS_KEY, CLIPS_KEY_PREFIX,
} from './useAudioAdmin.js';
import {
  itemsFromMisses, mergeItems, hasBatchActivity,
} from './audioBatch.js';
import { useAiProviders } from './useAiProviders.js';
import { useAudioPreview } from './useAudioPreview.js';
import AdminLoading from './AdminLoading.jsx';
import AudioBatchPanel from './AudioBatchPanel.jsx';
import AudioBatchControls from './AudioBatchControls.jsx';
import AudioLibrary from './AudioLibrary.jsx';
import SubjectSounds from './SubjectSounds.jsx';

const Wrap = styled.div`
  padding: 2rem; color: var(--s2-text); max-width: 1200px; margin: 0 auto;
  height: 100%; overflow-y: auto; background-color: var(--s2-surface);
`;
const Hint = styled.p`color: var(--s2-text-muted); font-size: 0.85rem; margin: 0.25rem 0;`;
const Err = styled.p`color: var(--s2-danger); font-size: 0.85rem; margin: 0.25rem 0;`;
const Tabs = styled.div`display: flex; gap: 0.5rem; margin-bottom: 1rem;`;
const TabButton = styled.button`
  background: ${(p) => (p.$active ? 'var(--s2-accent)' : 'none')};
  color: ${(p) => (p.$active ? 'var(--s2-on-accent)' : 'var(--s2-text)')};
  border: 1px solid var(--s2-border-strong); border-radius: 6px;
  padding: 0.35rem 0.9rem; font-size: 0.85rem; font-weight: bold; cursor: pointer;
`;
const Columns = styled.div`
  display: grid; grid-template-columns: 22rem 1fr; gap: 1.25rem; align-items: start;
  @media (max-width: 900px) { grid-template-columns: 1fr; }
`;
const Left = styled.div`
  border: 1px solid var(--s2-border); border-radius: 8px;
  background: var(--s2-surface-raised); padding: 0.75rem;
  input[type="text"] {
    width: 100%; box-sizing: border-box; background: var(--s2-bg-sunken); color: var(--s2-text);
    border: 1px solid var(--s2-border-strong); border-radius: 4px; padding: 0.4rem; font-size: 0.85rem;
    margin-bottom: 0.75rem;
  }
`;
const FilterRow = styled.div`display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.5rem;`;
const Right = styled.div`min-width: 0;`;
const Group = styled.div`
  margin-bottom: 0.75rem;
  h3 { margin: 0 0 0.35rem; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--s2-text-muted); }
  ul { list-style: none; margin: 0; padding: 0; }
`;
const SubjectRow = styled.li`display: flex; align-items: center; gap: 0.35rem;`;
const SubjectButton = styled.button`
  flex: 1; display: flex; align-items: center; justify-content: space-between; gap: 0.5rem;
  background: ${(p) => (p.$active ? 'var(--s2-overlay)' : 'none')};
  border: none; border-radius: 4px; padding: 0.35rem 0.5rem; cursor: pointer;
  color: var(--s2-text); font-size: 0.85rem; text-align: left;
  &:hover { background: var(--s2-overlay); }
`;
const Pill = styled.span`
  font-size: 0.72rem; padding: 0.05rem 0.4rem; border-radius: 999px; flex: none;
  background: var(--s2-bg-sunken); color: var(--s2-text-muted);
`;
const Missing = styled.div`
  border-top: 1px solid var(--s2-border); padding-top: 0.75rem; margin-top: 0.5rem;
  h3 { margin: 0 0 0.35rem; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--s2-text-muted); }
  ul { list-style: none; margin: 0; padding: 0; }
`;
const MissLi = styled.li`display: flex; align-items: center; gap: 0.35rem;`;
const MissRow = styled.button`
  flex: 1; display: flex; align-items: center; justify-content: space-between; gap: 0.5rem;
  background: none; border: none; border-radius: 4px; padding: 0.3rem 0.5rem; cursor: pointer;
  color: var(--s2-text); font-size: 0.78rem; text-align: left;
  &:hover { background: var(--s2-overlay); }
`;
const MissMeta = styled.span`font-size: 0.7rem; color: var(--s2-text-muted); display: block;`;
const Button = styled.button`
  background: var(--s2-accent); color: var(--s2-on-accent); border: none; border-radius: 6px;
  padding: 0.35rem 0.8rem; font-weight: bold; cursor: pointer; font-size: 0.8rem;
  &:disabled { opacity: 0.5; cursor: default; }
`;
const Secondary = styled(Button)`background: var(--s2-btn-grey);`;

const rowKey = (kind, key) => `${kind}/${key}`;
const missId = (m) => `${m.subject_kind}/${m.subject_key}/${m.slot}`;

function AudioAdmin() {
  const qc = useQueryClient();
  const { subjects, isLoadingSubjects, subjectsError } = useAudioSubjects();
  const { misses } = useAudioMisses();
  const { activeAudioProvider, isLoadingProviders } = useAiProviders();
  const { run, stats, recent } = useAudioJobs();
  const rows = useMemo(() => slotRows(subjects), [subjects]);
  const [tab, setTab] = useState('subjects');
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState(null);
  const [batchMode, setBatchMode] = useState(false);
  const [selectedSubjects, setSelectedSubjects] = useState(() => new Set());
  const [missSelected, setMissSelected] = useState(() => new Set());
  const [extraItems, setExtraItems] = useState([]);
  const preview = useAudioPreview();

  const styleNames = useMemo(() => (
    (activeAudioProvider?.models_cache || []).filter((m) => !m.startsWith('cue:'))
  ), [activeAudioProvider]);

  const grouped = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const byKind = new Map();
    for (const r of rows) {
      if (q && !`${r.key} ${r.kind}`.toLowerCase().includes(q)) continue;
      if (!byKind.has(r.kind)) byKind.set(r.kind, { label: r.label, rows: [] });
      byKind.get(r.kind).rows.push(r);
    }
    return [...byKind.values()];
  }, [rows, filter]);

  const visibleIds = useMemo(
    () => grouped.flatMap((g) => g.rows.map((r) => rowKey(r.kind, r.key))),
    [grouped],
  );
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedSubjects.has(id));
  const toggleSubject = (id) => setSelectedSubjects((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAllVisible = () => setSelectedSubjects((prev) => {
    const next = new Set(prev);
    if (allVisibleSelected) for (const id of visibleIds) next.delete(id);
    else for (const id of visibleIds) next.add(id);
    return next;
  });
  const toggleMiss = (id) => setMissSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const addMissesToBatch = () => {
    const picked = misses.filter((m) => missSelected.has(missId(m)));
    const items = itemsFromMisses(picked);
    if (items.length === 0) return;
    setExtraItems((prev) => mergeItems(prev, items));
    setMissSelected(new Set());
    setBatchMode(true);
  };

  const selectedRow = selected
    && rows.find((r) => r.kind === selected.kind && r.key === selected.key);
  // Review fix (SOMET-591): the post-drain cache refresh lives HERE, not in
  // AudioBatchPanel, and fires on run.running true -> false rather than on a
  // phase transition into finished/stopped specifically.
  //
  // Two things were wrong with the panel-local version: (1) AudioAdmin, not
  // the panel, stays mounted across the Subjects/Library tab switch and owns
  // the useAudioJobs() poll this reads from -- a drain that ended while an
  // admin was on the Library tab (the panel unmounted) never invalidated
  // anything. (2) Stop, the breaker, an unexpected error and no_provider all
  // typically leave jobs still queued, so the phase after they fire is
  // 'queued', not 'finished'/'stopped' -- watching for "left running" catches
  // every ending, not only the two that happen to end with an empty queue.
  const runningRef = useRef(Boolean(run && run.running));
  useEffect(() => {
    const runningNow = Boolean(run && run.running);
    const justEnded = runningRef.current && !runningNow;
    runningRef.current = runningNow;
    if (justEnded) {
      qc.invalidateQueries({ queryKey: SUBJECTS_KEY });
      qc.invalidateQueries({ queryKey: MISSES_KEY });
      qc.invalidateQueries({ queryKey: ALL_SLOTS_KEY });
      qc.invalidateQueries({ queryKey: CLIPS_KEY_PREFIX });
    }
  }, [run, qc]);

  if (subjectsError) return <Err>{String(subjectsError.message)}</Err>;

  if (!isLoadingSubjects && !isLoadingProviders && !activeAudioProvider) {
    return (
      <Wrap>
        <h2>Audio</h2>
        <Hint>
          No audio provider — add one under{' '}
          <Link to="/game/settings">AI Providers</Link> with modality Audio.
        </Hint>
      </Wrap>
    );
  }

  return (
    <Wrap>
      <h2>Audio</h2>
      <Tabs>
        <TabButton type="button" $active={tab === 'subjects'} onClick={() => setTab('subjects')}>Subjects</TabButton>
        <TabButton type="button" $active={tab === 'library'} onClick={() => setTab('library')}>Library</TabButton>
      </Tabs>

      {tab === 'library' && <AudioLibrary playback={preview} />}

      {tab === 'subjects' && (
        <>
          {isLoadingSubjects && <AdminLoading label="Loading subjects…" inline size={16} />}
          {hasBatchActivity({ run, stats }) && <AudioBatchPanel run={run} stats={stats} recent={recent} />}
          <Columns>
            <Left>
              <FilterRow>
                <input
                  type="text"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter subjects"
                  aria-label="Filter subjects"
                />
              </FilterRow>
              <FilterRow>
                <Secondary type="button" onClick={() => setBatchMode((v) => !v)}>
                  {batchMode ? 'Exit batch mode' : 'Batch mode'}
                </Secondary>
                {batchMode && (
                  <Secondary type="button" onClick={toggleAllVisible}>
                    {allVisibleSelected ? 'Deselect all visible' : 'Select all visible'}
                  </Secondary>
                )}
              </FilterRow>
              {grouped.map((g) => (
                <Group key={g.label}>
                  <h3>{g.label}</h3>
                  <ul>
                    {g.rows.map((r) => {
                      const id = rowKey(r.kind, r.key);
                      const active = Boolean(selected) && selected.kind === r.kind && selected.key === r.key;
                      return (
                        <SubjectRow key={id}>
                          {batchMode && (
                            <input
                              type="checkbox"
                              aria-label={`Select ${r.key} for the batch`}
                              checked={selectedSubjects.has(id)}
                              onChange={() => toggleSubject(id)}
                            />
                          )}
                          <SubjectButton
                            type="button"
                            $active={active}
                            onClick={() => setSelected({ kind: r.kind, key: r.key })}
                          >
                            <span>{r.key}</span>
                            <Pill>{r.filled}/{r.slots.length}</Pill>
                          </SubjectButton>
                        </SubjectRow>
                      );
                    })}
                    {g.rows.length === 0 && <Hint>No subjects match.</Hint>}
                  </ul>
                </Group>
              ))}

              <Missing>
                <h3>Missing sounds</h3>
                {misses.length === 0 && <Hint>Nothing missing.</Hint>}
                <ul>
                  {misses.map((m) => {
                    const id = missId(m);
                    const batchable = m.slot === 'music' || m.slot === 'ambience';
                    return (
                      <MissLi key={id}>
                        {batchMode && (
                          <input
                            type="checkbox"
                            aria-label={`Select ${id} for the batch`}
                            disabled={!batchable}
                            title={batchable ? undefined : 'SFX batches arrive in slice 3'}
                            checked={missSelected.has(id)}
                            onChange={() => toggleMiss(id)}
                          />
                        )}
                        <MissRow
                          type="button"
                          onClick={() => setSelected({ kind: m.subject_kind, key: m.subject_key })}
                        >
                          <span>
                            {m.subject_kind}/{m.subject_key} · {m.slot}
                            <MissMeta>last seen {String(m.last_seen).slice(0, 10)}</MissMeta>
                          </span>
                          <Pill>{m.count}×</Pill>
                        </MissRow>
                      </MissLi>
                    );
                  })}
                </ul>
                {batchMode && missSelected.size > 0 && (
                  <Secondary type="button" onClick={addMissesToBatch}>
                    Add {missSelected.size} to batch
                  </Secondary>
                )}
              </Missing>
            </Left>

            <Right>
              {batchMode ? (
                <AudioBatchControls
                  subjects={subjects}
                  selectedSubjects={selectedSubjects}
                  extraItems={extraItems}
                  setExtraItems={setExtraItems}
                  styleNames={styleNames}
                />
              ) : (
                <>
                  {!selectedRow && <Hint>Pick a subject on the left.</Hint>}
                  {selectedRow && (
                    <>
                      <h3>{selectedRow.label} · {selectedRow.key}</h3>
                      <SubjectSounds kind={selectedRow.kind} subjectKey={selectedRow.key} />
                    </>
                  )}
                </>
              )}
            </Right>
          </Columns>
        </>
      )}
    </Wrap>
  );
}

export default AudioAdmin;
