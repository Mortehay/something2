// The audio batch progress panel (SOMET-591, game audio slice 2). Mirrors
// ArtConsoleAdmin's Progress/Track/Fill block, adapted for TWO groups
// (music, ambience) drained one at a time in that order instead of a single
// flat queue -- see audioBatch.js's batchProgress/DRAIN_GROUPS.
//
// Shown by AudioAdmin whenever hasBatchActivity() says so (any group with a
// nonzero count, per audioBatch.js), not only while running -- same
// reasoning as the art console's SOMET-558 fix: a full queue with nothing
// draining it is exactly the state that most needs to stay visible.
//
// Purely presentational: it owns no invalidation of its own. The post-drain
// refresh (SUBJECTS_KEY/MISSES_KEY/ALL_SLOTS_KEY/CLIPS_KEY_PREFIX) lives in
// AudioAdmin, which stays mounted across the Subjects/Library tab switch and
// owns the useAudioJobs() call this panel is fed from -- a copy of that
// effect in here fired only while THIS component was mounted, so switching
// to the Library tab mid-drain silently dropped every ending it missed.
import styled from 'styled-components';
import {
  batchProgress, DRAIN_GROUPS_LABEL, queuedToDiscard, runStopWarning, groupRunningText,
  drainPhaseText, waitingText,
} from './audioBatch.js';
import {
  useStartAudioDrain, useStopAudioDrain, useRetryAudioFailures, useClearAudioJobs,
} from './useAudioAdmin.js';

const Panel = styled.section`
  border: 1px solid var(--s2-border); border-radius: 8px;
  background: var(--s2-surface-raised); padding: 0.75rem 1rem; margin: 0.75rem 0;
`;
const Head = styled.div`
  display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; justify-content: space-between;
  strong { font-size: 0.95rem; }
  span { font-size: 0.85rem; color: var(--s2-text-muted); }
`;
const Track = styled.div`
  height: 8px; border-radius: 999px; background: var(--s2-bg-sunken);
  margin: 0.5rem 0 0.6rem; overflow: hidden;
`;
const Fill = styled.div`
  height: 100%; background: var(--s2-accent); border-radius: 999px; transition: width 0.4s ease;
`;
const Groups = styled.div`
  display: flex; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 0.5rem;
`;
const GroupPill = styled.div`
  border: 1px solid ${(p) => (p.$active ? 'var(--s2-accent)' : 'var(--s2-border)')};
  border-radius: 6px; padding: 0.3rem 0.6rem; font-size: 0.8rem;
  color: ${(p) => (p.$active ? 'var(--s2-text)' : 'var(--s2-text-muted)')};
  b { color: var(--s2-text); }
`;
const Current = styled.p`
  margin: 0 0 0.5rem; font-size: 0.85rem; color: var(--s2-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
`;
const Waiting = styled.p`
  margin: 0 0 0.5rem; font-size: 0.85rem; color: var(--s2-warning, var(--s2-text));
  span { display: block; font-size: 0.78rem; color: var(--s2-text-muted); word-break: break-word; }
`;
const Controls = styled.div`display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center;`;
const Button = styled.button`
  background: var(--s2-accent); color: var(--s2-on-accent); border: none; border-radius: 6px;
  padding: 0.35rem 0.8rem; font-weight: bold; cursor: pointer; font-size: 0.8rem;
  &:disabled { opacity: 0.5; cursor: default; }
`;
const Secondary = styled(Button)`background: var(--s2-btn-grey);`;
const Warn = styled.p`
  color: var(--s2-danger); font-size: 0.85rem; margin: 0.5rem 0 0;
  border-top: 1px solid var(--s2-border); padding-top: 0.5rem;
`;
const Failures = styled.div`
  margin-top: 0.5rem; padding-top: 0.5rem; border-top: 1px solid var(--s2-border);
  h4 { margin: 0 0 0.3rem; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--s2-text-muted); }
  ul { list-style: none; margin: 0; padding: 0; }
  li { font-size: 0.78rem; color: var(--s2-text-muted); padding: 0.15rem 0; }
  code {
    display: block; font-size: 0.72rem; color: var(--s2-text-dim);
    background: var(--s2-bg-sunken); border-radius: 4px; padding: 0.25rem 0.4rem; margin-top: 0.1rem;
    overflow-x: auto; white-space: pre-wrap; word-break: break-word;
  }
`;

const GROUP_LABEL = {
  music: 'Music', ambience: 'Ambience', sfx_realistic: 'SFX (realistic)', sfx_retro: 'SFX (retro)',
};
// SOMET-591: same tooltip AudioSlotCard's Suggest/Generate and
// AudioSlotTable's Queue use, so only Start (a generation control) is
// gated -- Stop/Retry failed/Clear stay enabled with no provider.
const NO_PROVIDER_TITLE = 'No audio provider — add one under AI Providers';

function AudioBatchPanel({
  run, stats, recent, canGenerate = true,
}) {
  const start = useStartAudioDrain();
  const stop = useStopAudioDrain();
  const retry = useRetryAudioFailures();
  const clear = useClearAudioJobs();
  const progress = batchProgress({ run, stats });
  const failed = (recent || []).filter((r) => r.state === 'failed').slice(0, 10);
  const running = progress.phase === 'running';
  const discardable = queuedToDiscard({ run, stats });
  const stopWarning = runStopWarning(run);
  const phaseText = drainPhaseText(run);
  const waiting = waitingText(run);

  return (
    <Panel>
      <Head>
        <div>
          {progress.phase === 'running' && (
            <>
              <strong>{progress.done + progress.failed} of {progress.total} · {progress.pct}%</strong>{' '}
              <span>
                {run && run.stopping
                  ? 'stopping after the current job'
                  : `${phaseText ? `${phaseText} · ` : ''}drain: ${GROUP_LABEL[progress.group] || progress.group || '—'}`}
              </span>
            </>
          )}
          {progress.phase === 'queued' && <strong>{progress.queued + progress.running} queued — press Start</strong>}
          {progress.phase === 'finished' && <strong>Batch finished · {progress.done} done{progress.failed ? `, ${progress.failed} failed` : ''}</strong>}
          {progress.phase === 'stopped' && <strong>Batch stopped · {progress.done} done{progress.failed ? `, ${progress.failed} failed` : ''}</strong>}
          {progress.phase === 'idle' && <strong>No batch jobs</strong>}
        </div>
        {progress.backoff > 0 && <span>{progress.backoff} waiting on a busy provider</span>}
      </Head>

      {progress.total > 0 && (
        <Track role="progressbar" aria-valuenow={progress.pct} aria-valuemin={0} aria-valuemax={100} aria-label="Batch progress">
          <Fill style={{ width: `${progress.pct}%` }} />
        </Track>
      )}

      <Groups>
        {DRAIN_GROUPS_LABEL.map(([name, label]) => {
          const g = (stats && stats.groups && stats.groups[name]) || {
            queued: 0, running: 0, done: 0, failed: 0,
          };
          return (
            <GroupPill key={name} $active={progress.group === name}>
              {label}: <b>{g.done}</b> done · {g.queued} queued · {groupRunningText(run, g.running)}{g.failed ? ` · ${g.failed} failed` : ''}
            </GroupPill>
          );
        })}
      </Groups>

      {/* The drain pauses (never fails a job) while the box refuses a model
          switch; this is the only place an admin can see why nothing moves. */}
      {waiting && (
        <Waiting role="status">
          {waiting.line}
          {waiting.reason && <span>{waiting.reason}</span>}
        </Waiting>
      )}

      {run && run.current && (
        <Current>
          drawing {run.current.subject_kind}/{run.current.subject_key} · {run.current.slot}
        </Current>
      )}

      <Controls>
        <Button
          type="button"
          disabled={running || start.isPending || !canGenerate}
          title={canGenerate ? undefined : NO_PROVIDER_TITLE}
          onClick={() => start.mutate()}
        >
          {running ? 'Running…' : 'Start'}
        </Button>
        {running && (
          <Secondary type="button" disabled={stop.isPending} onClick={() => stop.mutate()}>Stop</Secondary>
        )}
        <Secondary type="button" disabled={retry.isPending} onClick={() => retry.mutate()}>Retry failed</Secondary>
        <Secondary
          type="button"
          disabled={running || clear.isPending}
          title={running ? 'Press Stop first' : undefined}
          onClick={() => {
            if (window.confirm('Clear finished and failed jobs? Queued jobs are kept.')) {
              clear.mutate(['done', 'failed']);
            }
          }}
        >
          Clear finished
        </Secondary>
        <Secondary
          type="button"
          disabled={running || clear.isPending || discardable === 0}
          title={running ? 'Press Stop first' : undefined}
          onClick={() => {
            if (window.confirm(`Discard ${discardable} queued job${discardable === 1 ? '' : 's'}? They will not be generated.`)) {
              clear.mutate(['queued']);
            }
          }}
        >
          Discard queued
        </Secondary>
      </Controls>

      {stopWarning && <Warn>{stopWarning}</Warn>}

      {failed.length > 0 && (
        <Failures>
          <h4>Last {failed.length} failure{failed.length === 1 ? '' : 's'}</h4>
          <ul>
            {failed.map((r) => (
              <li key={r.id}>
                {r.subject_kind}/{r.subject_key} · {r.slot}
                {r.last_error && <code>{r.last_error}</code>}
              </li>
            ))}
          </ul>
        </Failures>
      )}
    </Panel>
  );
}

export default AudioBatchPanel;
