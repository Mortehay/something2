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

// SOMET-605 (spec 3.6): the slots ONE subject carries. A group whose kind
// varies slots per subject (creature: boss slots only on boss rows) sends
// `subjectSlots`; without it every subject carries every slot. A subject
// missing from that map carries none. A demoted boss's boss-slot bindings are
// therefore hidden here, never offered for deletion (ruling D-demote).
export function slotEntriesFor(group, key) {
  const entries = Object.entries((group && group.slots) || {});
  if (!group || !group.subjectSlots) return entries;
  const names = group.subjectSlots[key];
  return names ? entries.filter(([s]) => names.includes(s)) : [];
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
    const filled = group.filledSlots || {};
    const prompts = group.promptStates || {};
    for (const key of group.subjects || []) {
      for (const [slot, clipKind] of slotEntriesFor(group, key)) {
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
          prompt: (prompts[key] && prompts[key][slot]) || 'none',
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
// 'cleared' is not a filter value of its own: it is a form of 'none' (see
// applyFilters below) -- both mean generation will use no stored prompt.
export const PROMPT_FILTERS = Object.freeze(['all', 'none', 'written', 'stale']);
// `missing` is the default for the same reason it is art's: it is the resume
// filter, the set an admin opens the tab to work through.
const DEFAULT_FILTERS = Object.freeze({
  kind: 'all', sound: 'missing', search: '', prompt: 'all',
});

// The filters live in the URL (`?kind=&sound=&q=`) so a reload or a shared
// link lands on the same table. An unknown sound value is dropped rather than
// trapping the table in a state no control on screen can leave, and so is an
// unknown kind once `knownKinds` (the registry's kinds, from the server) is
// non-empty: `?kind=nope` used to show "All kinds" in the <select> over an
// empty table, and choosing "All kinds" then fired no change event. Before
// the kinds load there is nothing to check against, so a deep link is kept.
export function filtersFromParams(params, knownKinds) {
  const sound = params.get('sound');
  const prompt = params.get('prompt');
  const kind = params.get('kind') || DEFAULT_FILTERS.kind;
  const kindKnown = kind === DEFAULT_FILTERS.kind || !knownKinds || knownKinds.length === 0
    || knownKinds.includes(kind);
  return {
    kind: kindKnown ? kind : DEFAULT_FILTERS.kind,
    sound: SOUND_FILTERS.includes(sound) ? sound : DEFAULT_FILTERS.sound,
    search: params.get('q') || DEFAULT_FILTERS.search,
    prompt: PROMPT_FILTERS.includes(prompt) ? prompt : DEFAULT_FILTERS.prompt,
  };
}

// The inverse, omitting defaults so the plain tab URL stays plain.
export function paramsFromFilters({
  kind, sound, search, prompt,
}) {
  const p = new URLSearchParams();
  if (kind && kind !== DEFAULT_FILTERS.kind) p.set('kind', kind);
  if (sound && sound !== DEFAULT_FILTERS.sound) p.set('sound', sound);
  if (search) p.set('q', search);
  if (prompt && prompt !== DEFAULT_FILTERS.prompt) p.set('prompt', prompt);
  return p;
}

export function applyFilters(rows, {
  kind = 'all', sound = 'all', search = '', prompt = 'all',
} = {}) {
  const q = search.trim().toLowerCase();
  return rows.filter((r) => {
    if (kind !== 'all' && r.kind !== kind) return false;
    if (sound === 'missing' && r.clips > 0) return false;
    if (sound === 'has' && r.clips === 0) return false;
    if (sound === 'reported' && !r.reported) return false;
    if (sound === 'failed' && !(r.job && r.job.status === 'failed')) return false;
    // 'cleared' counts as none: in both cases generation uses no stored prompt.
    if (prompt === 'none' && !(r.prompt === 'none' || r.prompt === 'cleared')) return false;
    if ((prompt === 'written' || prompt === 'stale') && r.prompt !== prompt) return false;
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

// How many sfx variants a queued job asks for. The default MUST equal the
// backend's DEFAULT_SFX_VARIANTS (audioGeneration.js) -- the pack size a job
// with no `variants` gets -- and audioSelection.test.js pins the two. The
// route accepts 1..MAX_SFX_VARIANTS.
export const DEFAULT_SFX_VARIANTS = 3;
export const MAX_SFX_VARIANTS = 5;

// POST /api/audio/admin/jobs items for exactly the selected slots. `rowsById`
// is a Map(slotId -> row) over ALL rows (not just the filtered ones -- the
// selection may be hidden by the filter and is still queued). `style` goes on
// music/ambience items when chosen (the route stores it; none means the box
// suggests one per subject); `engine` goes on every sfx item (the route's
// drain group; realistic when unset). `forcePrompt` (plan 2026-10-03, the
// "Force regenerate prompt" checkbox) puts `force_prompt: true` on every item,
// so the prompt phase rewrites even a stored or hand-written prompt; unticked,
// the field is left off and the server's default (false) applies.
// `variants` (SOMET-596 rework, the bar's Variants control) goes on every
// sfx item when it is an integer 1-5 -- the route's rule; it rejects the
// field on a music/ambience item, so it never goes there.
// Upload-only rows and ids that no longer name a row are not sent and are
// counted in `skipped`.
export function queueItems(selected, rowsById, {
  style = '', engine = 'realistic', forcePrompt = false, variants,
} = {}) {
  const items = [];
  let skipped = 0;
  const sendVariants = Number.isInteger(variants) && variants >= 1 && variants <= MAX_SFX_VARIANTS;
  for (const id of selected) {
    const r = rowsById.get(id);
    if (!r || r.uploadOnly) { skipped += 1; continue; }
    const it = { subject_kind: r.kind, subject_key: r.key, slot: r.slot };
    if (r.clipKind === 'sfx') {
      it.engine = engine || 'realistic';
      if (sendVariants) it.variants = variants;
    } else if (style) it.style = style;
    if (forcePrompt === true) it.force_prompt = true;
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
    known.set(g.kind, { group: g, keys: new Set(g.subjects || []) });
  }
  return (jobRows || []).filter((j) => {
    const k = known.get(j.subject_kind);
    return Boolean(k) && k.keys.has(j.subject_key)
      && slotEntriesFor(k.group, j.subject_key).some(([s]) => s === j.slot);
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

// --- Search box -------------------------------------------------------------

export const SEARCH_DEBOUNCE_MS = 250;

// The Search box's link to `?q=` (SOMET-596 rework). Binding the input to the
// URL param lost keystrokes: a commit re-filters every row and takes 30-300
// ms, and until it lands the input still shows the old value, so the next key
// is applied to that. The input shows its own text instead; `type` schedules
// one `commit` per pause, and `fromUrl(rendered, live)` says what the box
// should show when the rendered `?q=` changes: that value, or null (keep the
// typed text).
//
// `live` is the q in the address bar NOW (window.location). react-router
// writes the address bar synchronously but renders the new location inside
// startTransition, and while keys keep arriving that render is starved: the
// rendered q can trail the real one by several commits and land after a
// later commit fired (rework 2, measured live: "Titan Bru" typed, a late
// `?q=Titan Br` render reverted the box). A rendered value that differs
// from the live one is such a stale render, and is ignored; one that equals
// it is current, so back/forward and a shared link still reach the box.
// Null is also returned while a commit is still due (the user is mid-word).
export function createSearchSync(commit, delay = SEARCH_DEBOUNCE_MS) {
  let timer = null;
  let pending = null;
  return {
    type(value) {
      pending = value;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        const v = pending;
        timer = null;
        pending = null;
        commit(v);
      }, delay);
    },
    fromUrl(rendered, live = rendered) {
      if (pending !== null || rendered !== live) return null;
      return rendered;
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}

// The Variants box's text -> a variants count, or null when it is not an
// integer 1..MAX_SFX_VARIANTS. The box keeps its raw text (so Backspace then
// a digit works); this is checked on blur and on queue.
export function parseVariants(text) {
  const t = String(text ?? '').trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= MAX_SFX_VARIANTS ? n : null;
}

// `fn` (which returns a promise) wrapped so a call made while an earlier one
// is still in flight is dropped (returns undefined). "Retry these N" used
// disabled={isPending}, which takes effect a render later -- a fast
// double-click sent two POSTs 2 ms apart.
export function singleFlight(fn) {
  let busy = false;
  return (...args) => {
    if (busy) return undefined;
    busy = true;
    let p;
    try {
      p = Promise.resolve(fn(...args));
    } catch (err) {
      busy = false;
      throw err;
    }
    return p.finally(() => { busy = false; });
  };
}
