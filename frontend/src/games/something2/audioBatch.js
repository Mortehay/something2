// The audio batch console's upload-only and progress rules (SOMET-591,
// game audio slice 2). Pure, like artSelection.js/artProgress.js beside it,
// so the arithmetic here is testable without mounting a query hook or a
// running drain.

import { slotEntriesFor } from './audioSelection.js';

// Claims order, mirrored from backend/src/services/audioJobQueue.js's
// DRAIN_ORDER: music, then ambience, then the two SFX packs (realistic
// before retro), so the box switches model as rarely as possible. Kept here
// as a plain literal (not imported -- the frontend bundle cannot reach into
// backend/src) because it only decides which group batchProgress reports as
// "currently draining", never claim order itself.
const DRAIN_GROUPS = ['music', 'ambience', 'sfx_realistic', 'sfx_retro'];

// Same order, paired with a display label -- AudioBatchPanel renders its
// per-group pills from this rather than hardcoding the pair a second time.
export const DRAIN_GROUPS_LABEL = [
  ['music', 'Music'],
  ['ambience', 'Ambience'],
  ['sfx_realistic', 'SFX (realistic)'],
  ['sfx_retro', 'SFX (retro)'],
];

// A (kind, key, slot) id in the same "kind/key/slot" shape audioSelection.js's
// slotId uses, so a Set built here can be tested against the table's row ids.
function subjectSlotId(kind, key, slot) {
  return `${kind}/${key}/${slot}`;
}

// Every (kind, key, slot) that is upload-only -- an sfx slot whose cue is
// `null` in the registry's per-subject cue map (spec §4: "three slots have
// no cue on the box today"). Built once from GET /admin/subjects' `cues`
// field so the slot table (audioSelection.audioSlotRows) can mark them
// without a second request. A kind with no `cues` at all (world, biome -- music/ambience have
// no cue concept) simply contributes nothing.
export function uploadOnlySlotIds(subjectsResponse) {
  const out = new Set();
  for (const group of subjectsResponse || []) {
    for (const [key, bySlot] of Object.entries(group.cues || {})) {
      for (const [slot, cue] of Object.entries(bySlot || {})) {
        if (cue === null) out.add(subjectSlotId(group.kind, key, slot));
      }
    }
  }
  return out;
}

function groupTotals(stats) {
  const groups = (stats && stats.groups) || {};
  const out = {
    queued: 0, running: 0, done: 0, failed: 0,
  };
  for (const g of Object.values(groups)) {
    out.queued += Number(g.queued || 0);
    out.running += Number(g.running || 0);
    out.done += Number(g.done || 0);
    out.failed += Number(g.failed || 0);
  }
  return out;
}

// The group the panel should highlight: whichever is actively running, else
// the first (in DRAIN_ORDER) with work queued -- that is the group the next
// claim will pull from once a drain starts. Falls through to any group name
// outside DRAIN_GROUPS so a future group is never silently invisible, only
// unordered relative to music/ambience.
function currentGroup(stats) {
  const groups = (stats && stats.groups) || {};
  for (const name of DRAIN_GROUPS) if (groups[name] && groups[name].running > 0) return name;
  for (const name of DRAIN_GROUPS) if (groups[name] && groups[name].queued > 0) return name;
  for (const [name, g] of Object.entries(groups)) if (g.running > 0) return name;
  for (const [name, g] of Object.entries(groups)) if (g.queued > 0) return name;
  return null;
}

// One box's worth of "is it generating, and how far along": counts are
// summed across BOTH groups (a batch queues music and ambience together and
// the admin watches one drain work through both in DRAIN_ORDER), plus which
// group is current and whether a backoff is in effect (a busy box, spec §2).
//
// `run` is the dispatcher's own state (running/stopped_reason/...);
// `stats` is the GROUP BY over audio_jobs -- what is still owed. Neither
// alone answers "phase": a finished run with an empty queue is 'finished' or
// 'stopped' depending on WHY it stopped, and an idle page with jobs sitting
// queued (enqueued but never dispatched) is 'queued', not 'idle'.
//
// THE FALLBACK IS `total > 0`, NOT `run.done || run.failed || run.started_at`.
// `run` is the DISPATCHER'S IN-MEMORY state and is a zeroed shape
// (running:false, done:0, failed:0, started_at:null) after a backend
// restart -- but the done/failed ROWS in audio_jobs (what `stats` counts)
// survive a restart just fine. Reading only `run` here left a page with
// real failures on it reporting 'idle' the moment the backend restarted,
// which hid Retry/Clear and the failure list behind a panel that never
// rendered (see hasBatchActivity below, which the panel's visibility check
// uses instead of phase !== 'idle').
export function batchProgress({ run, stats } = {}) {
  const t = groupTotals(stats);
  const total = t.queued + t.running + t.done + t.failed;
  const outstanding = t.queued + t.running;
  const running = Boolean(run && run.running);

  let phase = 'idle';
  if (running) {
    phase = 'running';
  } else if (outstanding > 0) {
    // Work is waiting whether it was never started or was interrupted --
    // either way "queued" is the honest state, and Start/breaker messaging
    // is decided from run.stopped_reason directly by the panel, not folded
    // into this phase name.
    phase = 'queued';
  } else if (total > 0) {
    phase = (run && (run.stopped_reason === 'stopped' || run.stopped_reason === 'breaker')) ? 'stopped' : 'finished';
  }

  return {
    phase,
    done: t.done,
    failed: t.failed,
    queued: t.queued,
    running: t.running,
    total,
    pct: total > 0 ? Math.round(((t.done + t.failed) / total) * 100) : 0,
    group: currentGroup(stats),
    backoff: Number((stats && stats.backoff) || 0),
  };
}

// Whether AudioBatchPanel should render at all. Deliberately `total > 0`
// rather than `phase !== 'idle'` at the call site -- with the fallback fix
// above the two are equivalent today, but this gives the panel's visibility
// rule its own name and its own test, so a future phase tweak can't silently
// re-hide a panel that has real done/failed rows to show.
export function hasBatchActivity({ run, stats } = {}) {
  return batchProgress({ run, stats }).total > 0;
}

// One kind's slot list out of the subject registry response, e.g.
// subjectSlotsFor(subjects, 'world') -> [{slot:'music', clipKind:'music'}, ...].
// SubjectSounds.jsx (Task 7, embedded in the world and biome editors) knows
// its kind and one subject key up front, not the whole tree, so it needs only
// that kind's slot list, not the slot table's flattened rows.
//
// [] for a kind absent from the registry (an unknown subject kind, or the
// registry still loading/empty) rather than throwing -- SubjectSounds must
// keep rendering (its slot cards) even while useAudioSubjects() is loading or
// errored.
//
// SOMET-605: with a `key`, only that subject's slots (boss slots show on boss
// rows only); without one, the kind's whole slot list as before.
export function subjectSlotsFor(subjectsResponse, kind, key) {
  const group = (subjectsResponse || []).find((g) => g.kind === kind);
  if (!group) return [];
  const entries = key === undefined ? Object.entries(group.slots || {}) : slotEntriesFor(group, key);
  return entries.map(([slot, clipKind]) => ({ slot, clipKind }));
}

// Whether the jobs query is worth polling. Wider than "a drain is running"
// (SOMET-558 made the same call for the art console): a queue full of jobs
// with nothing draining them is exactly the state an admin needs the page to
// keep checking, not freeze on.
//
// QUEUED only, not queued + running: with no drain running, a 'running' row
// is an interrupted one (a backend restart mid-job) that nothing will touch
// until the next Start -- which flips run.running and resumes polling -- so
// polling on it just spins forever. That also makes "Discard queued" end the
// polling once the queue is empty.
export function shouldPoll({ run, stats } = {}) {
  if (run && run.running) return true;
  return groupTotals(stats).queued > 0;
}

// How many jobs "Discard queued" would remove: the queued count, or 0 while a
// drain runs (the server refuses clear then, and the button is disabled at 0).
export function queuedToDiscard({ run, stats } = {}) {
  if (run && run.running) return 0;
  return groupTotals(stats).queued;
}

// The warning under the batch controls for how the last drain ended. 'empty'
// (ran out of work) and 'stopped' (the admin pressed Stop) need none; every
// other reason -- 'breaker', 'no_provider', 'error' (a DB fault that ended
// the drain) -- is shown WITH run.error, since that is the only place the
// admin can see why the batch stopped short.
export function runStopWarning(run) {
  const reason = run && run.stopped_reason;
  if (!reason || reason === 'empty' || reason === 'stopped') return null;
  const detail = run.error || 'no detail';
  if (reason === 'breaker') {
    return `Stopped after repeated provider failures (${detail}) — fix the provider, then press Start to resume.`;
  }
  return `Batch stopped (${reason}): ${detail} — fix the cause, then press Start to resume.`;
}

// A slot card's job line (SOMET-592). A job left 'queued' when the drain
// ended -- a breaker trip, no provider, a fault, Stop, or a drain that never
// started -- will not move until someone presses Start, so "queued" alone
// reads as "about to run" when it is not. The line says the drain stopped,
// and why when the run recorded a reason.
export function slotJobText(job, run) {
  if (!job) return null;
  if (job.status === 'failed') return job.error ? `Job: failed — ${job.error}` : 'Job: failed';
  if (job.status !== 'queued' || (run && run.running)) return `Job: ${job.status}`;
  const reason = run && run.stopped_reason;
  const detail = (run && run.error) || 'no detail';
  if (reason === 'breaker') {
    return `Job: queued — the drain stopped after repeated provider failures (${detail}); press Start on the Audio page once the provider is fixed.`;
  }
  if (reason === 'no_provider' || reason === 'error') {
    return `Job: queued — the drain stopped (${reason}): ${detail}; press Start on the Audio page once that is fixed.`;
  }
  return 'Job: queued — no drain is running; press Start on the Audio page to run it.';
}

// A group pill's running count. With no drain running those rows are
// interrupted (see shouldPoll), and "running" would claim work is happening
// that is not -- Start is what picks them back up.
export function groupRunningText(run, count) {
  if (count > 0 && !(run && run.running)) return `${count} interrupted — press Start`;
  return `${count} running`;
}

// SOMET-596 review I1: whether a job finished between two polls of the jobs
// stats -- the moment the slot table's clip counts (and its Job column) go
// stale. A finished slot drops out of /jobs/slots at once, but its Sound
// column still says "missing" until the subjects query refetches, and
// "Select all matching → Queue" would re-queue it. So AudioAdmin refreshes
// on every rise, not only when the drain ends.
//
// A FALL (Clear finished deleted done rows) or the first poll (no previous
// stats) is not a rise.
export function doneRose(prevStats, stats) {
  if (!prevStats || !stats) return false;
  return groupTotals(stats).done > groupTotals(prevStats).done;
}

// Plan 2026-10-03: the drain runs in phases -- every pending prompt is
// written on the text model first, then audio is generated group by group.
// runStatus().phase is 'prompt' | 'audio' while one runs, else null.
export function drainPhaseText(run) {
  const phase = run && run.phase;
  if (phase === 'prompt') return 'writing prompts';
  if (phase === 'audio') return 'generating audio';
  return null;
}

// Plan 2026-10-03: while the box refuses a model switch (busy, or a model
// pinned in the box UI) the drain pauses and retries -- run.waiting is
// { model, reason, since } then, else null. `since` is an ISO timestamp,
// shown as local hh:mm; an unparseable one is left out rather than "NaN:NaN".
export function waitingText(run) {
  const w = run && run.waiting;
  if (!w) return null;
  const at = w.since ? new Date(w.since) : null;
  const since = at && !Number.isNaN(at.getTime())
    ? ` (since ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')})`
    : '';
  return { line: `Waiting for box: ${w.model || 'unknown model'}${since}`, reason: w.reason || null };
}
