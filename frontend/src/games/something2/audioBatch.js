// The audio batch console's selection, merge and progress rules (SOMET-591,
// game audio slice 2). Pure, like artSelection.js/artProgress.js beside it,
// so the arithmetic here is testable without mounting a query hook or a
// running drain.

// Claims order, mirrored from backend/src/services/audioJobQueue.js's
// DRAIN_ORDER: music before ambience, so the box switches model at most once
// per group. Kept here as a plain literal (not imported -- the frontend
// bundle cannot reach into backend/src) because it only decides which group
// batchProgress reports as "currently draining", never claim order itself.
const DRAIN_GROUPS = ['music', 'ambience'];

// Same order, paired with a display label -- AudioBatchPanel renders its
// per-group pills from this rather than hardcoding the pair a second time.
export const DRAIN_GROUPS_LABEL = [['music', 'Music'], ['ambience', 'Ambience']];

// Only these two slot NAMES are batchable today (spec: sfx batches arrive in
// slice 3). For the subject-tree path (buildBatchItems) the registry's own
// per-slot clip kind is the source of truth; this set is used only where the
// input has no clip-kind information at all -- the misses list, which only
// ever carries a slot's NAME.
const BATCHABLE_SLOTS = new Set(['music', 'ambience']);

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

// The ticked subjects (kind/key ids) × the ticked slots per kind, filtered
// down to slots that ACTUALLY EXIST on that kind and excluding sfx --
// `slotChoice` is a UI convenience (one set of ticks reused across every
// selected subject of a kind) and can therefore ask for a slot a given kind
// doesn't have (e.g. a biome has no music slot); this is what silently drops
// those requests instead of sending the server an item it would reject.
//
// A ticked id that no longer names a real subject (stale selection after a
// catalogue edit) is skipped rather than sent -- the same rule
// checkSubject() enforces server-side, applied client-side so the count on
// the "Queue N jobs" button matches what will actually be queued.
export function buildBatchItems(selectedSubjects, slotChoice, subjectsResponse) {
  const groups = new Map((subjectsResponse || []).map((g) => [g.kind, g]));
  const items = [];
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
      if (clipKind === undefined || clipKind === 'sfx') continue;
      items.push({ subject_kind: kind, subject_key: key, slot });
    }
  }
  return sortItems(dedupe(items));
}

// The missing-sounds rows, narrowed to music/ambience (sfx misses are real
// but not batchable until slice 3 -- the caller disables their checkbox with
// that exact sentence, this is the corresponding server-bound filter).
export function itemsFromMisses(missRows) {
  const items = (missRows || [])
    .filter((m) => m && BATCHABLE_SLOTS.has(m.slot))
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
export function shouldPoll({ run, stats } = {}) {
  if (run && run.running) return true;
  const t = groupTotals(stats);
  return (t.queued + t.running) > 0;
}
