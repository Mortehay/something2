// The Audio admin tab (SOMET-590/591/596).
//
// Two tabs: Subjects and Library. Subjects is AudioSlotTable (SOMET-596): one
// row per (kind, key, slot), filterable and paged, with "Queue N selected",
// failed-by-cause retry, and the clicked subject's slot cards beside it --
// the Art Generation tab's pattern. Library is every stored clip, independent
// of any subject.
//
// EVERY RULE about what a slot accepts lives on the backend (audioSubjects.js,
// audioLibrary.js); the table's selection/filter/paging rules live in
// audioSelection.js and the batch progress arithmetic in audioBatch.js.
// This file fetches, owns the post-drain refresh, and renders.
import {
  useEffect, useMemo, useRef, useState,
} from 'react';
import { Link } from 'react-router-dom';
import styled from 'styled-components';
import { useQueryClient } from '@tanstack/react-query';
import {
  useAudioSubjects, useAudioMisses, useAudioJobs, useAudioSlotJobs,
  SUBJECTS_KEY, MISSES_KEY, ALL_SLOTS_KEY, CLIPS_KEY_PREFIX, SLOT_JOBS_KEY,
} from './useAudioAdmin.js';
import { hasBatchActivity, shouldPoll, doneRose } from './audioBatch.js';
import { useAiProviders, audioProviderState } from './useAiProviders.js';
import { useAudioPreview } from './useAudioPreview.js';
import AdminLoading from './AdminLoading.jsx';
import AudioBatchPanel from './AudioBatchPanel.jsx';
import AudioLibrary from './AudioLibrary.jsx';
import AudioSlotTable from './AudioSlotTable.jsx';

const Wrap = styled.div`
  padding: 2rem; color: var(--s2-text); max-width: 1400px; margin: 0 auto;
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

function AudioAdmin() {
  const qc = useQueryClient();
  const { subjects, isLoadingSubjects, subjectsError } = useAudioSubjects();
  const { misses } = useAudioMisses();
  const { activeAudioProvider, isLoadingProviders, providersError } = useAiProviders();
  const { canGenerate, banner } = audioProviderState({
    activeAudioProvider, isLoading: isLoadingProviders, error: providersError,
  });
  const { run, stats, recent } = useAudioJobs();
  // Same cadence as the batch panel: polls while a drain runs or jobs are
  // queued, and stops when that does (audioBatch.shouldPoll).
  const { slotJobs } = useAudioSlotJobs({ poll: shouldPoll({ run, stats }) });
  const [tab, setTab] = useState('subjects');
  const preview = useAudioPreview();

  const styleNames = useMemo(() => (
    (activeAudioProvider?.models_cache || []).filter((m) => !m.startsWith('cue:'))
  ), [activeAudioProvider]);

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
  //
  // SOMET-596: the slot table's clip counts (SUBJECTS_KEY) and Job column
  // (SLOT_JOBS_KEY) are refreshed here too -- the last poll before the drain
  // ended can predate its final job.
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
      qc.invalidateQueries({ queryKey: SLOT_JOBS_KEY });
    }
  }, [run, qc]);

  // SOMET-596 review I1: refresh WHILE a drain runs, not only after it. A
  // slot whose job just finished drops out of /jobs/slots at once, but its
  // clip count (the subjects query) would still say "missing" -- and
  // "Select all matching → Queue" would re-queue it. So every poll on which
  // the done total rose refetches the counts, the Job column and any open
  // slot cards (doneRose, in audioBatch.js, is the tested rule).
  const statsRef = useRef(stats);
  useEffect(() => {
    const prev = statsRef.current;
    statsRef.current = stats;
    if (doneRose(prev, stats)) {
      qc.invalidateQueries({ queryKey: SUBJECTS_KEY });
      qc.invalidateQueries({ queryKey: SLOT_JOBS_KEY });
      qc.invalidateQueries({ queryKey: ALL_SLOTS_KEY });
    }
  }, [stats, qc]);

  if (subjectsError) return <Err>{String(subjectsError.message)}</Err>;

  return (
    <Wrap>
      <h2>Audio</h2>
      {/* Non-blocking (SOMET-591 fix): the tab below stays usable -- library,
          upload, bind-from-library, volume/weight/remove, the batch panel's
          Retry/Clear/Stop, and the failed-slot retries all work without a
          provider. Only the generation controls (Suggest/Generate/Queue/Start)
          are disabled, via canGenerate threaded down to them. */}
      {banner === 'none' && (
        <Hint>
          No audio provider — add one under{' '}
          <Link to="/game/settings">AI Providers</Link> with modality Audio.
        </Hint>
      )}
      {banner === 'error' && <Err>Could not load AI providers.</Err>}
      <Tabs>
        <TabButton type="button" $active={tab === 'subjects'} onClick={() => setTab('subjects')}>Subjects</TabButton>
        <TabButton type="button" $active={tab === 'library'} onClick={() => setTab('library')}>Library</TabButton>
      </Tabs>

      {tab === 'library' && <AudioLibrary playback={preview} />}

      {tab === 'subjects' && (
        <>
          {isLoadingSubjects && <AdminLoading label="Loading subjects…" inline size={16} />}
          {hasBatchActivity({ run, stats }) && (
            <AudioBatchPanel run={run} stats={stats} recent={recent} canGenerate={canGenerate} />
          )}
          <AudioSlotTable
            subjects={subjects}
            misses={misses}
            slotJobs={slotJobs}
            canGenerate={canGenerate}
            styleNames={styleNames}
          />
        </>
      )}
    </Wrap>
  );
}

export default AudioAdmin;
