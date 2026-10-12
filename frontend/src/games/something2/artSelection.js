// The mass-generation console's selection and paging rules (SOMET-538).
//
// Pure, so every rule below is testable without rendering anything. The
// component renders these; it decides nothing.

// A subject is identified by KIND PLUS KEY, never by key alone. "Focus" is both
// a real passive label and a plausible skill id, and a selection that collided
// them would enqueue one and silently drop the other -- the same namespacing
// catalog_art uses for its primary key.
export function subjectId(s) {
  return `${s.kind}/${s.key}`;
}

// SORTED ON SOMETHING IMMUTABLE BY DEFAULT. Rows gain art while a batch runs,
// so ordering by has-art (or by updated_at, which moves for the same reason)
// shuffles subjects between pages mid-batch: the admin ticks row 40, a
// generation lands, and row 40 is now a different subject. Kind then key never
// moves, so it stays the default.
//
// Sorting by `updated` is now offered because an admin watching a batch wants
// to see what just landed, which the immutable order cannot show. The hazard
// the paragraph above describes is real but narrower than it reads: selection
// is keyed by subjectId, not by row index, so a tick FOLLOWS its subject and
// cannot silently become a different one. What genuinely moves is the page
// COMPOSITION -- which rows are on screen, and therefore what "select this
// page" means. freezeOrder below is the answer to that, not a warning label.
export function sortSubjects(subjects, { by = 'subject', dir = 'asc' } = {}) {
  const rows = [...subjects];
  if (by !== 'updated') {
    return rows.sort((a, b) => (
      a.kind === b.kind ? a.key.localeCompare(b.key) : a.kind.localeCompare(b.kind)
    ));
  }
  const sign = dir === 'asc' ? 1 : -1;
  return rows.sort((a, b) => {
    const av = a.updated_at ? String(a.updated_at) : null;
    const bv = b.updated_at ? String(b.updated_at) : null;
    // A subject with no date has never been generated. It sorts LAST in both
    // directions rather than at one end: treating "never" as the epoch would
    // bury the newest results under 600 blanks when sorting ascending, and
    // "oldest first" is not a sensible reading of "no date at all".
    if (av === null && bv === null) return a.key.localeCompare(b.key);
    if (av === null) return 1;
    if (bv === null) return -1;
    if (av === bv) return a.key.localeCompare(b.key);   // stable, not arbitrary
    return av < bv ? -sign : sign;
  });
}

// Re-apply a previously captured order, so a live batch cannot reshuffle the
// table under the admin's cursor.
//
// Subjects the snapshot has never seen go to the END rather than being dropped
// -- a filter change can widen the set while the freeze is held, and silently
// omitting rows would be far worse than showing them late.
export function freezeOrder(subjects, order) {
  if (!Array.isArray(order) || order.length === 0) return [...subjects];
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...subjects].sort((a, b) => {
    const ai = rank.has(subjectId(a)) ? rank.get(subjectId(a)) : Number.MAX_SAFE_INTEGER;
    const bi = rank.has(subjectId(b)) ? rank.get(subjectId(b)) : Number.MAX_SAFE_INTEGER;
    return ai === bi ? subjectId(a).localeCompare(subjectId(b)) : ai - bi;
  });
}

export const PAGE_SIZE = 100;

export function pageCount(total, pageSize = PAGE_SIZE) {
  return Math.max(1, Math.ceil((total || 0) / pageSize));
}

// Clamped rather than trusted: deleting the filter's last matches while sitting
// on page 7 must not leave an empty table with no way back.
export function clampPage(page, total, pageSize = PAGE_SIZE) {
  return Math.min(Math.max(1, page || 1), pageCount(total, pageSize));
}

// --- Selection ------------------------------------------------------------

export function toggle(selected, id) {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

// "Select page" means THIS PAGE, and it is a distinct act from "select all
// matching". Conflating them is the mistake this ticket calls out: an admin who
// ticks the header box expecting 100 and gets 617 has started a batch six times
// the size they intended.
export function selectPage(selected, pageSubjects) {
  const next = new Set(selected);
  for (const s of pageSubjects) next.add(subjectId(s));
  return next;
}

export function deselectPage(selected, pageSubjects) {
  const next = new Set(selected);
  for (const s of pageSubjects) next.delete(subjectId(s));
  return next;
}

export function isPageFullySelected(selected, pageSubjects) {
  return pageSubjects.length > 0 && pageSubjects.every((s) => selected.has(subjectId(s)));
}

// Everything the CURRENT FILTER matches, not everything that exists.
export function selectAllMatching(matching) {
  return new Set(matching.map(subjectId));
}

// What the button should say. The count is spelled out because "select all" is
// ambiguous about which "all" it means, and the answer changes with the filter.
export function selectAllLabel(matchingCount, pageCountShown) {
  if (matchingCount <= pageCountShown) return null;   // nothing more to offer
  return `Select all ${matchingCount} matching the filter`;
}

// Group a selection back into per-kind key lists, because the enqueue endpoint
// takes one kind at a time.
export function byKind(selected) {
  const out = new Map();
  for (const id of selected) {
    const slash = id.indexOf('/');
    const kind = id.slice(0, slash);
    const key = id.slice(slash + 1);        // keys may contain '/' themselves
    if (!out.has(kind)) out.set(kind, []);
    out.get(kind).push(key);
  }
  return out;
}


// Forced prompt generation is unavailable for subjects that compose their own
// prompts (currently tiles). Count them so the queue action can be disabled
// before a per-kind request produces a partial enqueue.
export function promptIneligibleCount(selected, subjects) {
  const byId = new Map(subjects.map((subject) => [subjectId(subject), subject]));
  let count = 0;
  for (const id of selected) {
    const subject = byId.get(id);
    if (!subject || subject.takes_description !== true) count += 1;
  }
  return count;
}


// How much of the selection the current filter is NOT showing.
//
// Selection deliberately SURVIVES a filter change -- filtering to items,
// selecting some, then filtering to skills and selecting more is a real
// workflow and clearing on every change would make it impossible. The hazard is
// that it does so INVISIBLY: switch from "missing art" to "has art" and the
// button still says "Queue 100 selected" while not one of them is on screen.
// Found in the browser, not by a test.
//
// So the selection is kept and the discrepancy is stated.
export function selectionOutsideFilter(selected, matching) {
  const visible = new Set(matching.map(subjectId));
  let hidden = 0;
  for (const id of selected) if (!visible.has(id)) hidden += 1;
  return hidden;
}

// --- Filtering ------------------------------------------------------------

// The art filter's whole vocabulary, in one place: applyFilters reads it and
// filtersFromParams validates against it.
export const ART_FILTERS = Object.freeze(['all', 'missing', 'has', 'failed']);

// SOMET-571. The console's initial filters from a deep link (`?kind=&art=&q=`),
// so the Skill Tree tab can land on exactly one subject. Anything absent keeps
// the console's own default -- art=missing, the resume filter -- and an art
// value the console has no control for is dropped rather than trapping the
// table in a state nothing on screen can leave.
//
// `kind` is not validated here: the kinds come from the server, and the
// console's <select> simply shows no such option for an unknown one.
//
// `key=` names ONE subject and is matched exactly (`exact: true`); `q=` is
// the search box's substring match. The Skill Tree tab links with key=,
// because q=Mage also matches Afterimage, Pyromancy and five more labels.
export function filtersFromParams(params) {
  const art = params.get('art');
  const key = params.get('key');
  return {
    kind: params.get('kind') || 'all',
    art: ART_FILTERS.includes(art) ? art : 'missing',
    search: key || params.get('q') || '',
    exact: Boolean(key),
  };
}

// The inverse, omitting the console defaults so the plain tab URL stays plain.
// SOMET-535: the console writes its filters back through this, so browser
// back/forward and a reload land on the same table.
// An exact search goes back out as key= so it stays exact across back/reload.
export function paramsFromFilters({ kind, art, search, exact = false }) {
  const p = new URLSearchParams();
  if (kind && kind !== 'all') p.set('kind', kind);
  if (art && art !== 'missing') p.set('art', art);
  if (search) p.set(exact ? 'key' : 'q', search);
  return p;
}

// SOMET-535. Tells the console's own URL writes apart from navigation that
// came from outside (browser back, a Skill Tree deep link). React Router
// applies setSearchParams as a deferred update, so while someone is typing
// the URL can commit a value they have already typed past ('wa' after 'war').
// An input bound to the URL snapped back to it and lost keys. The console
// therefore keeps the typed text in its own state and adopts a URL value only
// when it is not one of its own writes.
export function createUrlEcho() {
  const written = new Set();
  return {
    wrote(params) { written.add(params.toString()); },
    // true when `params` came from outside and the console should adopt it
    adopt(params) {
      if (written.has(params.toString())) return false;
      written.clear();
      return true;
    },
  };
}

// Why Start batch cannot run, or null when it can. A LOCAL batch is drawn by
// the sprite-gen service and needs no remote provider (SOMET-535); a connector
// batch needs a chosen one or an active one.
export function startBatchBlocker({ backend, providerId, activeProvider }) {
  if (backend === 'local') return null;
  if (providerId || activeProvider) return null;
  return 'Choose a provider, or set an active one in AI Providers';
}

// The POST /api/art-jobs/dispatch body. Under Local it carries NO
// provider_id: the server starts a provider-less batch only when every queued
// job is local, and a provider left in the hidden select must not turn a
// Local start into a remote batch (SOMET-535).
export function startBatchBody({ backend, providerId, activeProvider }) {
  if (backend === 'local') return { concurrency: 1 };
  return { provider_id: providerId ? Number(providerId) : activeProvider?.id, concurrency: 1 };
}

// The Error useStartArtBatch throws for a refused POST /dispatch. A 409 is an
// admin clicking twice, or two admins at once: the batch IS running, so it is
// tagged rather than reported (SOMET-535 rework 4). 400 is usually the
// resolution precondition, whose message names the misconfigured provider, so
// it passes through verbatim along with WHICH queued groups block the start.
export function dispatchError(status, json = {}) {
  if (status === 409) {
    const err = new Error('A batch is already running');
    err.alreadyRunning = true;
    return err;
  }
  const err = new Error(json.error || 'Failed to start the batch');
  err.blocked = Array.isArray(json.blocked) ? json.blocked : [];
  return err;
}

// The text of a refused Start that the Blocked panel does NOT explain, or
// null (SOMET-535 rework 3). A refusal carrying blocked groups is the size
// refusal, rendered with its own drop button; every other refusal -- a Local
// start against connector jobs, an empty queue, a misconfigured provider, a
// double start -- used to render nowhere, because the only place the message
// was printed was inside that panel.
export function startErrorMessage(error) {
  if (!error) return null;
  if (error.alreadyRunning) return null;
  if (Array.isArray(error.blocked) && error.blocked.length) return null;
  return error.message || 'Failed to start the batch';
}

// `exact`: `search` is a subject key, compared as-is (no case folding, name
// not searched). Otherwise a case-insensitive substring of key and name.
export function applyFilters(subjects, { kind = 'all', art = 'all', search = '', exact = false } = {}) {
  const q = search.trim().toLowerCase();
  return subjects.filter((s) => {
    if (kind !== 'all' && s.kind !== kind) return false;
    if (art === 'missing' && s.has_art) return false;
    if (art === 'has' && !s.has_art) return false;
    if (art === 'failed' && s.job_state !== 'failed') return false;
    if (exact && search && s.key !== search) return false;
    if (!exact && q && !`${s.key} ${s.name || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

// --- Reporting ------------------------------------------------------------

// Enqueue is idempotent server-side, so "I selected 100 and 3 were queued" is
// the normal case rather than an error -- but it is baffling without the
// breakdown. Each number is named.
export function enqueueSummary(results) {
  const t = results.reduce((acc, r) => ({
    requested: acc.requested + (r.requested || 0),
    queued: acc.queued + (r.queued || 0),
    alreadyLive: acc.alreadyLive + (r.already_live || 0),
    unknown: acc.unknown + ((r.unknown && r.unknown.length) || 0),
  }), { requested: 0, queued: 0, alreadyLive: 0, unknown: 0 });

  const parts = [`Queued ${t.queued} of ${t.requested}`];
  if (t.alreadyLive) parts.push(`${t.alreadyLive} already in flight`);
  if (t.unknown) parts.push(`${t.unknown} no longer in the catalogue`);
  return { ...t, message: parts.join(' — ') };
}

// One submission at a time, decided SYNCHRONOUSLY. A mutation's isPending
// only disables the button after the next render, so two clicks in the same
// tick both got through: two POSTs, and the second response ("Queued 0 of 2
// -- 2 already in flight") overwrote the first. A call made while one is
// pending joins it and gets the same result. `slot` is a React ref.
export function joinInFlight(slot, start) {
  if (slot.current) return slot.current;
  const pending = Promise.resolve()
    .then(start)
    .finally(() => { slot.current = null; });
  slot.current = pending;
  return pending;
}

// Progress from the CATALOG, not from a counter. A counter drifts; "how many of
// these subjects have art" is answerable at any moment and cannot.
export function coverage(subjects) {
  const total = subjects.length;
  const withArt = subjects.filter((s) => s.has_art).length;
  const failed = subjects.filter((s) => s.job_state === 'failed').length;
  return { total, withArt, failed, missing: total - withArt };
}
