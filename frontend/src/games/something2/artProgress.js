// How far a batch has got, and how long the rest will take (SOMET-558).
//
// Pure, like artSelection.js beside it, so every rule here is testable without
// rendering anything and without a running drain to observe.
//
// THE NUMBERS COME FROM TWO SOURCES AND NEITHER IS A COUNTER WE KEEP.
// `stats` is a GROUP BY over art_jobs -- what is still owed -- and `run` is the
// dispatcher's own tally of what THIS drain has resolved. Adding a third
// tracker in the browser would drift from both, which is the mistake the
// dispatcher's header already warns against.

// A batch is in exactly one of four states, and conflating any two of them is
// how the console came to look dead while holding 530 queued jobs.
//
// The distinction that matters most is idleQueued vs running. `queued` rows
// generate NOTHING on their own: "Queue N selected" writes rows, "Start batch"
// is what claims them and calls the provider. An admin who has done the first
// and not the second sees a full queue and no images, and the page owes them
// that sentence rather than a spinner.
export const IDLE = 'idle';               // nothing queued, nothing running
export const IDLE_QUEUED = 'idleQueued';  // jobs waiting, no drain to pull them
export const RUNNING = 'running';         // a drain is working
export const FINISHED = 'finished';       // a drain ran and the queue is empty

// A PERCENTAGE IS DELIBERATELY WITHHELD WHEN IDLE, and this is the whole
// reason the phase exists rather than a bare pct.
//
// `run` survives a finished drain -- runStatus() keeps the last one so the
// admin can read why it stopped -- so a fresh selection queued afterwards would
// be measured against the PREVIOUS run's completions: 530 newly queued against
// 97 done last week reads as "15% complete" before a single image is drawn.
// Every phase that cannot honestly divide returns pct null, and the component
// renders a sentence instead of a bar.
export function batchProgress(run, stats, { now = Date.now() } = {}) {
  const queued = Number(stats?.queued || 0);
  const inFlight = Number(stats?.running || 0);
  const remaining = queued + inFlight;
  const running = Boolean(run?.running);

  if (running) {
    // `failed` counts here too. A subject that has exhausted its attempts is
    // resolved -- it will never be claimed again -- so excluding it would leave
    // the bar permanently short of 100% on any batch that lost a subject, and
    // an admin would sit watching a stalled 98% waiting for work that is done.
    const completed = Number(run.done || 0) + Number(run.failed || 0);
    const total = completed + remaining;
    return {
      phase: RUNNING,
      stopping: Boolean(run.stopping),
      completed,
      remaining,
      total,
      pct: total > 0 ? Math.round((completed / total) * 100) : 0,
      etaMs: etaMs(run, completed, remaining, now),
    };
  }

  if (remaining > 0) {
    return {
      phase: IDLE_QUEUED, stopping: false, completed: 0, remaining, total: remaining,
      pct: null, etaMs: null,
    };
  }

  if (run && (run.done || run.failed)) {
    return {
      phase: FINISHED, stopping: false,
      completed: Number(run.done || 0) + Number(run.failed || 0),
      remaining: 0,
      total: Number(run.done || 0) + Number(run.failed || 0),
      pct: 100,
      etaMs: null,
    };
  }

  return { phase: IDLE, stopping: false, completed: 0, remaining: 0, total: 0, pct: null, etaMs: null };
}

// The rate is measured from THIS run, not assumed from a per-image constant.
//
// Generation time is a property of the remote card and the subject, not of our
// code: the same batch runs at ~20s an image on a warm pipeline and several
// times that on a cold or contended one. A hardcoded seconds-per-image would be
// confidently wrong on the machine that matters.
//
// Withheld below MIN_SAMPLES because the first completion also carries model
// load -- extrapolating a 530-image batch from it overstates the total by
// hours, and an ETA that swings from "9h" to "2h" in the first minute teaches
// the admin to ignore the field.
const MIN_SAMPLES = 3;

function etaMs(run, completed, remaining, now) {
  if (completed < MIN_SAMPLES || remaining === 0) return null;
  const started = Date.parse(run.started_at || '');
  if (!Number.isFinite(started)) return null;
  const elapsed = now - started;
  if (elapsed <= 0) return null;
  return Math.round((elapsed / completed) * remaining);
}

// Coarse on purpose. An ETA derived from a handful of samples is not accurate
// to the second, and printing "2h 14m 07s" would claim a precision the input
// does not have.
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// Elapsed time for the "drawing now" line, which is a DIFFERENT job from
// formatDuration above and must not reuse it.
//
// formatDuration coarsens with scale, which is right for an estimate and wrong
// here: past 60s it would print "1m" for a whole minute, and a counter that
// sits unchanged for sixty seconds is indistinguishable from a hung page --
// precisely the impression this whole panel exists to remove. The seconds
// field is the liveness signal, so it is always present.
//
// Zero-padded past a minute so the text does not change width every second and
// jitter the layout beside it.
export function formatElapsed(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = String(s % 60).padStart(2, '0');
  if (m < 60) return `${m}m ${rem}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m ${rem}s`;
}

// Seconds since a job was claimed, for the "drawing now" line.
//
// Returns null rather than 0 for an unparseable timestamp, so the component can
// omit the field instead of asserting a generation started this instant.
export function elapsedSince(claimedAt, now = Date.now()) {
  const t = Date.parse(claimedAt || '');
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((now - t) / 1000));
}

// Whether the queue is worth polling for.
//
// The console polled ONLY while a drain was running, which made the one state
// an admin most needs to watch -- a full queue with nothing pulling it -- the
// one state that never refreshed. Anything outstanding is worth a poll.
export function shouldPollQueue(run, stats) {
  if (run?.running) return true;
  return Number(stats?.queued || 0) + Number(stats?.running || 0) > 0;
}

// Which of the claimed jobs is actually ON the provider (SOMET-558).
//
// THE TRAP THIS EXISTS FOR. dispatch() claims `limit` jobs in ONE update --
// ten by default -- and then runs them through `concurrency` workers pulling
// from a shared cursor, one by default. So ten rows sit in state='running'
// while a single subject is being drawn, and listing them all as "drawing"
// claims ten parallel generations against a card measured to have headroom for
// exactly one pipeline.
//
// SORTED BY id, NOT BY claimed_at. A single UPDATE stamps every claimed row
// with the identical timestamp, so ordering by it is a tie across the whole
// batch and the browser may show any of them first. claim() orders by id and
// the worker cursor walks that array in order, so ascending id IS the
// processing order -- the lowest id still running is the one on the provider.
export function partitionInFlight(rows, concurrency = 1) {
  const list = [...(Array.isArray(rows) ? rows : [])]
    .sort((a, b) => Number(a.id) - Number(b.id));
  const n = Math.max(1, concurrency);
  return { drawing: list.slice(0, n), waiting: list.slice(n) };
}

// "claimed 2m 14s ago", never "drawing for 2m 14s".
//
// claimed_at is when the job was TAKEN, not when the provider started on it,
// and for every job after the first in a claimed batch those differ by however
// long the ones ahead of it took. Saying "drawing for" would overstate the
// second subject's time by the first subject's whole generation. The number
// still moves once a second, which is what it is there for; only the claim it
// makes is narrowed to one that is true.
//
// An accurate "drawing for" needs the dispatcher to stamp a row when a worker
// actually picks it up, which is a schema change and a backend restart -- and
// restarting the backend kills the in-memory drain of any batch in flight.
export function claimedAgo(claimedAt, now = Date.now()) {
  const secs = elapsedSince(claimedAt, now);
  return secs === null ? null : formatElapsed(secs);
}

// How many subject names to print before summarising the rest.
//
// The list answers "are these the rows I meant to queue", and that question is
// settled by the first screenful: a batch of 512 is checked by recognising the
// first dozen keys, not by reading all 512 in a panel above the table that
// already lists every one of them. The server caps its payload separately and
// lower caps win, so this number can only ever shorten what is drawn.
export const QUEUE_PREVIEW = 12;
export const WAITING_PREVIEW = 6;

// A capped list of subject names plus how many were not named.
//
// `total` IS PASSED IN rather than taken from rows.length, because the rows are
// already a server-side preview of a longer queue -- deriving the count from
// what arrived would print "12 queued" over a backlog of 512, which is the
// exact class of confident-but-wrong count this panel exists to remove.
//
// Clamped at zero so a total that lags the rows by a poll (a job claimed
// between the two reads) can never render "+-1 more".
export function previewNames(rows, total, limit = QUEUE_PREVIEW) {
  const list = Array.isArray(rows) ? rows : [];
  const names = list.slice(0, Math.max(0, limit))
    .map((j) => `${j.subject_kind}/${j.subject_key}`);
  const n = Number(total);
  const size = Number.isFinite(n) ? Math.max(n, list.length) : list.length;
  return { names, more: Math.max(0, size - names.length) };
}
