// The Audio tab's slot table (SOMET-596): rows, filters, paging, selection,
// queue items and the failed-by-cause grouping.
//
// Modelled on artSelection.js, but deliberately its own module rather than a
// shared one: the art table is one row per SUBJECT and the audio table is one
// row per SLOT, so their ids, filters and selection rules differ, and coupling
// the two tabs would make every change to one a risk to the other.
//
// Pure, so every rule here is testable in vitest's node env. AudioAdmin.jsx
// renders these; it decides nothing.

// A row is identified by KIND, KEY and SLOT. Kind is part of it for the same
// reason artSelection's subjectId has it: two kinds can share a key. Keys may
// contain '/', which is harmless here because an id is only ever looked up,
// never split back apart.
export function slotId(kind, key, slot) {
  return `${kind}/${key}/${slot}`;
}

// GET /admin/jobs/slots rows -> Map(slotId -> { id, status, error }).
export function jobsBySlotFrom(jobRows) {
  const out = new Map();
  for (const j of jobRows || []) {
    out.set(slotId(j.subject_kind, j.subject_key, j.slot), { id: j.id, status: j.status, error: j.error ?? null });
  }
  return out;
}

// GET /admin/misses rows -> Set of slot ids the game reported as missing.
export function missesSetFrom(missRows) {
  return new Set((missRows || []).map((m) => slotId(m.subject_kind, m.subject_key, m.slot)));
}

// One row per (kind, key, slot), in registry order: kinds as the server lists
// them, subjects as listed within a kind, slots in the kind's slot order. That
// order never changes while a batch runs (clip counts and job states do), so
// rows do not move between pages under the admin's cursor.
//
// `jobsBySlot` is jobsBySlotFrom's Map, `missesSet` missesSetFrom's Set and
// `uploadOnlyIds` audioBatch.uploadOnlySlotIds' Set; any may be absent.
export function audioSlotRows(subjectsResponse, jobsBySlot, missesSet, uploadOnlyIds) {
  const jobs = jobsBySlot || new Map();
  const misses = missesSet || new Set();
  const uploadOnly = uploadOnlyIds || new Set();
  const out = [];
  for (const group of subjectsResponse || []) {
    const slots = Object.entries(group.slots || {});
    const filled = group.filledSlots || {};
    for (const key of group.subjects || []) {
      for (const [slot, clipKind] of slots) {
        const id = slotId(group.kind, key, slot);
        out.push({
          id,
          kind: group.kind,
          kindLabel: group.label || group.kind,
          key,
          slot,
          clipKind,
          clips: (filled[key] && filled[key][slot]) || 0,
          uploadOnly: uploadOnly.has(id),
          reported: misses.has(id),
          job: jobs.get(id) || null,
        });
      }
    }
  }
  return out;
}

// The Sound column's text.
export function soundText(row) {
  if (row.clips > 0) return `${row.clips} clip${row.clips === 1 ? '' : 's'}`;
  return row.uploadOnly ? 'upload only' : 'missing';
}

// --- Filtering --------------------------------------------------------------

export const SOUND_FILTERS = Object.freeze(['all', 'missing', 'has', 'reported', 'failed']);
// `missing` is the default for the same reason it is art's: it is the resume
// filter, the set an admin opens the tab to work through.
const DEFAULT_FILTERS = Object.freeze({ kind: 'all', sound: 'missing', search: '' });

// The filters live in the URL (`?kind=&sound=&q=`) so a reload or a shared
// link lands on the same table. An unknown sound value is dropped rather than
// trapping the table in a state no control on screen can leave. `kind` is not
// validated: the kinds come from the server, and an unknown one just matches
// nothing (the <select> shows no such option).
export function filtersFromParams(params) {
  const sound = params.get('sound');
  return {
    kind: params.get('kind') || DEFAULT_FILTERS.kind,
    sound: SOUND_FILTERS.includes(sound) ? sound : DEFAULT_FILTERS.sound,
    search: params.get('q') || DEFAULT_FILTERS.search,
  };
}

// The inverse, omitting defaults so the plain tab URL stays plain.
export function paramsFromFilters({ kind, sound, search }) {
  const p = new URLSearchParams();
  if (kind && kind !== DEFAULT_FILTERS.kind) p.set('kind', kind);
  if (sound && sound !== DEFAULT_FILTERS.sound) p.set('sound', sound);
  if (search) p.set('q', search);
  return p;
}

export function applyFilters(rows, { kind = 'all', sound = 'all', search = '' } = {}) {
  const q = search.trim().toLowerCase();
  return rows.filter((r) => {
    if (kind !== 'all' && r.kind !== kind) return false;
    if (sound === 'missing' && r.clips > 0) return false;
    if (sound === 'has' && r.clips === 0) return false;
    if (sound === 'reported' && !r.reported) return false;
    if (sound === 'failed' && !(r.job && r.job.status === 'failed')) return false;
    if (q && !`${r.key} ${r.slot}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

// --- Paging -----------------------------------------------------------------

export const PAGE_SIZE = 100;

export function pageCount(total, pageSize = PAGE_SIZE) {
  return Math.max(1, Math.ceil((total || 0) / pageSize));
}

// Clamped rather than trusted: a filter that shrinks the result while the
// admin sits on page 7 must not leave an empty table with no way back.
export function clampPage(page, total, pageSize = PAGE_SIZE) {
  return Math.min(Math.max(1, page || 1), pageCount(total, pageSize));
}

// --- Selection --------------------------------------------------------------
//
// Upload-only rows (an sfx slot the provider has no cue for) can never be
// queued -- the server rejects them -- so they are never selectable, and the
// page/all helpers skip them rather than selecting something the Queue button
// would then have to drop.

const selectable = (r) => !r.uploadOnly;

export function toggle(selected, id) {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

// "Select page" means THIS PAGE, a distinct act from "select all matching"
// (see artSelection.selectPage for why conflating them is dangerous).
export function selectPage(selected, pageRows) {
  const next = new Set(selected);
  for (const r of pageRows) if (selectable(r)) next.add(r.id);
  return next;
}

export function deselectPage(selected, pageRows) {
  const next = new Set(selected);
  for (const r of pageRows) next.delete(r.id);
  return next;
}

export function isPageFullySelected(selected, pageRows) {
  const pick = pageRows.filter(selectable);
  return pick.length > 0 && pick.every((r) => selected.has(r.id));
}

// Everything the CURRENT FILTER matches, not everything that exists.
export function selectAllMatching(matching) {
  return new Set(matching.filter(selectable).map((r) => r.id));
}

// How much of the selection the current filter is NOT showing. The selection
// survives filter changes on purpose (artSelection.selectionOutsideFilter);
// this is what makes that visible instead of silent.
export function selectionOutsideFilter(selected, matching) {
  const visible = new Set(matching.map((r) => r.id));
  let hidden = 0;
  for (const id of selected) if (!visible.has(id)) hidden += 1;
  return hidden;
}

// --- Queueing ---------------------------------------------------------------

// POST /api/audio/admin/jobs items for exactly the selected slots. `rowsById`
// is a Map(slotId -> row) over ALL rows (not just the filtered ones -- the
// selection may be hidden by the filter and is still queued). `style` goes on
// music/ambience items when chosen (the route stores it; none means the box
// suggests one per subject); `engine` goes on every sfx item (the route's
// drain group; realistic when unset). Upload-only rows and ids that no longer
// name a row are not sent and are counted in `skipped`.
export function queueItems(selected, rowsById, { style = '', engine = 'realistic' } = {}) {
  const items = [];
  let skipped = 0;
  for (const id of selected) {
    const r = rowsById.get(id);
    if (!r || r.uploadOnly) { skipped += 1; continue; }
    const it = { subject_kind: r.kind, subject_key: r.key, slot: r.slot };
    if (r.clipKind === 'sfx') it.engine = engine || 'realistic';
    else if (style) it.style = style;
    items.push(it);
  }
  items.sort((a, b) => slotId(a.subject_kind, a.subject_key, a.slot)
    .localeCompare(slotId(b.subject_kind, b.subject_key, b.slot)));
  return { items, skipped };
}

// POST /api/audio/admin/jobs' per-request item cap. It MUST equal the
// route's MAX_JOB_ITEMS (backend/src/api/audioRoutes.js) -- the frontend
// bundle cannot import backend code, so audioSelection.test.js reads that
// file and pins the two together.
export const MAX_JOB_ITEMS = 500;

// A selection split into requests the route accepts. "Select all 1697
// matching" is the tab's headline workflow, and one 1697-item request is a
// 400 that queues nothing.
export function chunkItems(items, size = MAX_JOB_ITEMS) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Sends the chunks ONE AFTER ANOTHER (each request validates its items one
// by one on the server; parallel requests would only contend) and stops at
// the first failure. Returns { results, error, unsent }: the responses that
// came back, the error that stopped it (or null), and the items of the
// failed chunk and every chunk after it -- what the caller should keep
// selected so the admin can press Queue again.
export async function queueInChunks(items, send, size = MAX_JOB_ITEMS) {
  const chunks = chunkItems(items, size);
  const results = [];
  for (let i = 0; i < chunks.length; i += 1) {
    try {
      results.push(await send(chunks[i]));
    } catch (error) {
      return { results, error, unsent: chunks.slice(i).flat() };
    }
  }
  return { results, error: null, unsent: [] };
}

// The enqueue responses (one per chunk) as one sentence. Enqueue is
// idempotent, so "3 selected, 1 queued" is a normal outcome and needs its
// breakdown. `clientSkipped` is queueItems' own count (never sent); each
// response's `rejected` adds to it. `error`, when a chunk failed, is stated
// together with how much was queued before it.
export function enqueueSummary(results, clientSkipped = 0, error = null) {
  const list = Array.isArray(results) ? results : [];
  let queued = 0;
  let alreadyLive = 0;
  let skipped = clientSkipped || 0;
  let noProvider = false;
  for (const json of list) {
    queued += ((json && json.queued) || []).length;
    alreadyLive += ((json && json.already_live) || []).length;
    skipped += ((json && json.rejected) || []).length;
    if (json && json.started === false && json.reason === 'no_provider') noProvider = true;
  }
  const parts = [`Queued ${queued}`];
  if (alreadyLive) parts.push(`${alreadyLive} already in flight`);
  if (skipped) parts.push(`${skipped} skipped`);
  if (noProvider) parts.push('no audio provider — press Start once one is active');
  let message = parts.join(' — ');
  if (error) message = `Stopped after an error: ${error.message || error}. ${message} before it; the rest stay selected.`;
  return {
    queued, alreadyLive, skipped, message,
  };
}

// --- Failed, by cause -------------------------------------------------------

// What counts as a VARYING part of an error, and nothing else (SOMET-596
// review): ids, uuids, hashes, file paths/object keys, long numbers and
// quoted subject names. Short numbers are kept -- "answered 404" and
// "answered 503" are different problems (one permanent, one a busy box) and
// must never share a "Retry these N" button -- and so is ordinary prose.
const PATH = /(?:\/?[\w.-]+\/)+[\w.-]*\.[A-Za-z0-9]{2,5}\b/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// Hex runs of 8+ that contain both a digit and a letter (a digit-only run is
// a long number, below; a letter-only run is a word).
const HASH = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi;
// A quoted name in PROSE ("unknown subject 'Bat'", "no style 'village-x'"):
// a short identifier-like string right after a word. Not JSON -- a value
// after ':' is a message ("detail": "CUDA out of memory") and is kept -- and
// not an apostrophe inside a word ("can't", "isn't").
const QUOTED = /(?<=[A-Za-z] )(['"`])[\w .:/-]{1,64}\1(?!\w)/g;
const LABELLED_ID = /\b(id|job|row|clip|batch)(\s*[#:=]?\s*)\d+\b/gi;
const HASH_ID = /#\d+\b/g;
const LONG_NUMBER = /\b\d{4,}\b/g;

// An error's cause with its varying parts blanked -- quoted names, paths,
// uuids and hashes become '…', ids and long numbers become 'N' -- so the
// same failure on different subjects groups together while different
// failures stay apart. Order matters: paths before uuids (an object key
// usually contains one), uuids before numbers.
export function normalizeCause(error) {
  if (error === null || error === undefined || String(error).trim() === '') return '(no error text)';
  return String(error)
    .replace(PATH, '…')
    .replace(UUID, '…')
    .replace(HASH, '…')
    .replace(QUOTED, '…')
    .replace(LABELLED_ID, (m, word, sep) => `${word}${sep}N`)
    .replace(HASH_ID, '#N')
    .replace(LONG_NUMBER, 'N')
    .replace(/\s+/g, ' ')
    .trim();
}

// Job rows whose (kind, key, slot) is still in the subjects registry. A job
// for a deleted subject can never succeed (the server refuses it as an
// unknown subject), so the by-cause panel and its "Retry these N" count
// leave it out rather than offer a retry that fails again.
export function jobsForKnownSubjects(jobRows, subjectsResponse) {
  const known = new Map();
  for (const g of subjectsResponse || []) {
    known.set(g.kind, { keys: new Set(g.subjects || []), slots: g.slots || {} });
  }
  return (jobRows || []).filter((j) => {
    const k = known.get(j.subject_kind);
    return Boolean(k) && k.keys.has(j.subject_key) && Object.prototype.hasOwnProperty.call(k.slots, j.slot);
  });
}

// How many of `rows` are upload-only -- shown beside the pager's count, since
// they match "missing" but "Select all" skips them.
export function uploadOnlyCount(rows) {
  let n = 0;
  for (const r of rows) if (r.uploadOnly) n += 1;
  return n;
}

const SAMPLES = 12;

// Failed jobs grouped by normalized cause, biggest group first. Each group
// carries every job id (for "Retry these N"), the first raw error text (the
// provider's own words), and up to 12 sample slot ids plus how many more.
// Takes /admin/jobs/slots rows; anything not failed is ignored.
export function failedByCause(jobRows) {
  const groups = new Map();
  for (const j of jobRows || []) {
    if (j.status !== 'failed') continue;
    const cause = normalizeCause(j.error);
    if (!groups.has(cause)) groups.set(cause, { cause, text: j.error || '', ids: [], slots: [] });
    const g = groups.get(cause);
    g.ids.push(j.id);
    g.slots.push(slotId(j.subject_kind, j.subject_key, j.slot));
  }
  return [...groups.values()]
    .map((g) => ({
      cause: g.cause,
      text: g.text,
      count: g.ids.length,
      ids: g.ids,
      samples: g.slots.slice(0, SAMPLES),
      more: Math.max(0, g.slots.length - SAMPLES),
    }))
    .sort((a, b) => b.count - a.count || a.cause.localeCompare(b.cause));
}
