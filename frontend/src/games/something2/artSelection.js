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

export function applyFilters(subjects, { kind = 'all', art = 'all', search = '' } = {}) {
  const q = search.trim().toLowerCase();
  return subjects.filter((s) => {
    if (kind !== 'all' && s.kind !== kind) return false;
    if (art === 'missing' && s.has_art) return false;
    if (art === 'has' && !s.has_art) return false;
    if (art === 'failed' && s.job_state !== 'failed') return false;
    if (q && !`${s.key} ${s.name || ''}`.toLowerCase().includes(q)) return false;
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

// Progress from the CATALOG, not from a counter. A counter drifts; "how many of
// these subjects have art" is answerable at any moment and cannot.
export function coverage(subjects) {
  const total = subjects.length;
  const withArt = subjects.filter((s) => s.has_art).length;
  const failed = subjects.filter((s) => s.job_state === 'failed').length;
  return { total, withArt, failed, missing: total - withArt };
}
