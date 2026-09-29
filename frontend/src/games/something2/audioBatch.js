// The audio batch console's selection, merge and progress rules (SOMET-591,
// game audio slice 2). Pure, like artSelection.js/artProgress.js beside it,
// so the arithmetic here is testable without mounting a query hook or a
// running drain.

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

function dedupeKey(it) {
  return `${it.subject_kind}/${it.subject_key}/${it.slot}`;
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = dedupeKey(it);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

// Stable (kind, key, slot) order -- not because the dispatcher claims in this
// order (it claims by drain_group, then id), but so the "Queue N jobs"
// preview and the enqueue body read the same list twice in a row, and two
// separate ticks that produce the same set always render identically.
function sortItems(items) {
  return [...items].sort((a, b) => {
    if (a.subject_kind !== b.subject_kind) return a.subject_kind.localeCompare(b.subject_kind);
    if (a.subject_key !== b.subject_key) return a.subject_key.localeCompare(b.subject_key);
    return a.slot.localeCompare(b.slot);
  });
}

// A (kind, key, slot) id in the same "kind/key/slot" shape AudioAdmin.jsx's
// missId uses, so a Set built from one can be tested against the other.
function subjectSlotId(kind, key, slot) {
  return `${kind}/${key}/${slot}`;
}

// Every (kind, key, slot) that is upload-only -- an sfx slot whose cue is
// `null` in the registry's per-subject cue map (spec §4: "three slots have
// no cue on the box today"). Built once from GET /admin/subjects' `cues`
// field so buildBatchItems/itemsFromMisses can skip them without a second
// request. A kind with no `cues` at all (world, biome -- music/ambience have
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

// The ticked subjects (kind/key ids) × the ticked slots per kind, filtered
// down to slots that ACTUALLY EXIST on that kind -- `slotChoice` is a UI
// convenience (one set of ticks reused across every selected subject of a
// kind) and can therefore ask for a slot a given kind doesn't have (e.g. a
// biome has no music slot); this is what silently drops those requests
// instead of sending the server an item it would reject.
//
// sfx slots are included, EXCEPT upload-only ones (no cue on the provider --
// spec §4): those are reported in `skipped` with the reason, so the caller
// can show them struck through instead of silently dropping them the way a
// stale subject id is dropped below.
//
// A ticked id that no longer names a real subject (stale selection after a
// catalogue edit) is skipped rather than sent -- the same rule
// checkSubject() enforces server-side, applied client-side so the count on
// the "Queue N jobs" button matches what will actually be queued.
export function buildBatchItems(selectedSubjects, slotChoice, subjectsResponse) {
  const groups = new Map((subjectsResponse || []).map((g) => [g.kind, g]));
  const items = [];
  const skipped = [];
  for (const id of selectedSubjects || []) {
    const slash = id.indexOf('/');
    if (slash < 0) continue;
    const kind = id.slice(0, slash);
    const key = id.slice(slash + 1);
    const group = groups.get(kind);
    if (!group || !Array.isArray(group.subjects) || !group.subjects.includes(key)) continue;
    const wanted = slotChoice && slotChoice[kind];
    if (!wanted) continue;
    const slotDefs = group.slots || {};
    for (const slot of wanted) {
      const clipKind = slotDefs[slot];
      if (clipKind === undefined) continue;
      if (clipKind === 'sfx') {
        const cue = group.cues && group.cues[key] ? group.cues[key][slot] : undefined;
        if (cue === null) {
          skipped.push({
            subject_kind: kind, subject_key: key, slot, reason: 'upload only: no cue on the provider',
          });
          continue;
        }
      }
      items.push({ subject_kind: kind, subject_key: key, slot });
    }
  }
  return { items: sortItems(dedupe(items)), skipped };
}

// The missing-sounds rows, narrowed to whatever `uploadOnlyIds` (from
// uploadOnlySlotIds, above) marks as upload-only -- sfx misses are now
// batchable like music/ambience (spec, game audio slice 3), except those. A
// missing `uploadOnlyIds` (e.g. the registry hasn't loaded yet) blocks
// nothing, matching buildBatchItems' own "undefined cue is not null" rule.
export function itemsFromMisses(missRows, uploadOnlyIds) {
  const blocked = uploadOnlyIds || new Set();
  const items = (missRows || [])
    .filter((m) => m && !blocked.has(subjectSlotId(m.subject_kind, m.subject_key, m.slot)))
    .map((m) => ({ subject_kind: m.subject_kind, subject_key: m.subject_key, slot: m.slot }));
  return sortItems(dedupe(items));
}

// Union two item lists (subject-tree ticks + misses added via "Add to
// batch"), deduped by subject/slot so re-adding the same miss twice -- or a
// miss that is also covered by the subject-tree selection -- queues one job,
// not two, which would collide on audio_jobs' unique-per-live-slot index.
export function mergeItems(a, b) {
  return sortItems(dedupe([...(a || []), ...(b || [])]));
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
// This is useAudioAdmin.js's slotRows() narrowed to a single kind and without
// the per-subject fan-out -- SubjectSounds.jsx (Task 7, embedded in the world
// and biome editors) knows its kind and one subject key up front, not the
// whole tree, so it has no use for slotRows' per-subject `filled` count or
// its flattened kind×subject rows.
//
// [] for a kind absent from the registry (an unknown subject kind, or the
// registry still loading/empty) rather than throwing -- SubjectSounds must
// keep rendering (its slot cards) even while useAudioSubjects() is loading or
// errored.
export function subjectSlotsFor(subjectsResponse, kind) {
  const group = (subjectsResponse || []).find((g) => g.kind === kind);
  if (!group) return [];
  return Object.entries(group.slots || {}).map(([slot, clipKind]) => ({ slot, clipKind }));
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

// A group pill's running count. With no drain running those rows are
// interrupted (see shouldPoll), and "running" would claim work is happening
// that is not -- Start is what picks them back up.
export function groupRunningText(run, count) {
  if (count > 0 && !(run && run.running)) return `${count} interrupted — press Start`;
  return `${count} running`;
}
