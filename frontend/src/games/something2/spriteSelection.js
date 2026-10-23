import { PAGE_SIZE, clampPage, pageCount } from './artSelection.js';

export function spriteShape(subject) {
  return subject.is_creature || subject.is_playable ? 'directional' : 'flat';
}

export function hasSpriteVisual(subject) {
  return Boolean(subject.sprite || (subject.image && subject.render_mode !== 'rect'));
}

export function filterSpriteSubjects(subjects, { shape = 'all', status = 'missing', search = '' } = {}) {
  const needle = search.trim().toLowerCase();
  return subjects.filter((subject) => {
    if (shape !== 'all' && spriteShape(subject) !== shape) return false;
    if (needle && !subject.name.toLowerCase().includes(needle)) return false;
    if (status === 'missing') return !hasSpriteVisual(subject);
    if (status !== 'all') return subject.job_state === status;
    return true;
  });
}

export function toggleSpriteSubject(selected, id) {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

export function selectAllSpriteSubjects(subjects) {
  return new Set(subjects.map((subject) => subject.id));
}

// Selected rows -> POST /jobs body. An appearance-variant row's own `id` is
// the synthetic "entityId:variant" string used for selection, not the real id
// the backend wants -- `entity_id` carries that instead (see spriteBatchRoutes.js).
export function targetsForSprites(selectedRows) {
  return selectedRows.map((subject) => ({
    entity_id: subject.variant == null ? subject.id : subject.entity_id,
    variant: subject.variant,
  }));
}


// One page of the filtered table. The page is clamped, not trusted: approving
// the last "ready for review" rows while sitting on page 3 must not leave an
// empty table with no way back. Paging rules are shared with the Art console.
export function spritePage(matching, page) {
  const shown = clampPage(page, matching.length);
  return {
    page: shown,
    pages: pageCount(matching.length),
    rows: matching.slice((shown - 1) * PAGE_SIZE, shown * PAGE_SIZE),
  };
}

// The header checkbox means THIS PAGE, distinct from "select all matching".
export function setSpritePageSelected(selected, pageRows, on) {
  const next = new Set(selected);
  for (const subject of pageRows) {
    if (on) next.add(subject.id); else next.delete(subject.id);
  }
  return next;
}

export function isSpritePageSelected(selected, pageRows) {
  return pageRows.length > 0 && pageRows.every((subject) => selected.has(subject.id));
}

// --- Box action catalog helpers ---------------------------------------------

const FACINGS = { directional: 8 };

export function framesCap(catalog, actions) {
  const caps = (catalog?.actions || [])
    .filter((action) => actions.includes(action.id))
    .map((action) => action.max_frames);
  return caps.length ? Math.min(...caps) : catalog?.max_frames ?? 1;
}

// A flat prop is one txt2img cutout on the box (Props v2, SOMET-657:
// one static image, animated by the game's idle effect), so it counts as 1 cell whatever the
// actions and frames; a creature is a sheet of facings x actions x frames.
export function cellCount(rows, actions, frames) {
  return rows.reduce(
    (sum, row) => sum + (spriteShape(row) === 'flat' ? 1 : FACINGS.directional * actions.length * frames),
    0,
  );
}

// A GPU-box prop row made the Props v2 way: one generated cutout image, no sheet. A box
// prop done before Props v2 still carries a sheet (atlas_key) and previews as one.
// The image a row was (or would be) drawn from: the box concept once
// generated, else a hero appearance's own art, else the entity's existing art.
function isPropSubject(subject) {
  return subject?.generation_kind === 'object' || isBoxProp(subject);
}

export function conceptImageOf(subject) {
  if (isPropSubject(subject)) return subject?.concept_key || subject?.appearance_image || subject?.image || null;
  return subject?.concept_key || subject?.kept_concept_key || null;
}

export function conceptLabelOf(subject) {
  if (isPropSubject(subject)) {
    if (subject?.concept_key) return 'Used image';
    if (subject?.appearance_image) return 'Appearance art';
    if (subject?.image) return 'Current art';
    return 'Used image';
  }
  if (subject?.concept_key) return 'Used concept';
  if (subject?.kept_concept_key) return 'Concept — reused';
  return 'New concept will be drawn';
}

const LAST_UPDATE_OPTIONS = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false };

// The Last update column: local "23 Oct 01:12", the raw ISO as the hover title.
export function lastUpdateLabel(iso) {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return { text: '—', title: '' };
  return { text: new Intl.DateTimeFormat('en-GB', LAST_UPDATE_OPTIONS).format(date).replace(',', ''), title: String(iso) };
}

export function deleteConfirmText(n) {
  return `Delete all generated sprites for ${n} subject${n === 1 ? '' : 's'}? Sheets, redraws and queued jobs are removed; concepts are kept. This cannot be undone.`;
}

// What the Sheet / Result column shows: only output of a sprite job (sheet or
// prop result) or an approved sprite sheet -- never the entity's plain art,
// which made every entity with Art Generation art look already rendered.
export function sheetImageOf(subject) {
  return subject?.atlas_key || subject?.image_key || subject?.sheet_atlas_key || subject?.sprite?.atlas_key || null;
}

export function sheetManifestOf(subject) {
  return subject?.manifest_key || subject?.sheet_manifest_key || null;
}

const REDRAW_STATE_LABELS = {
  queued: 'redraw queued', running: 'redrawing', done: 'ready for review', failed: 'redraw failed',
};

export function jobStateLabel(subject) {
  if (subject?.redraw_of) return REDRAW_STATE_LABELS[subject.job_state] || subject.job_state || 'not queued';
  return subject?.job_state || 'not queued';
}

export function isBoxProp(subject) {
  return subject?.backend === 'gpu-box' && subject?.generation_kind === 'object' && !subject?.atlas_key;
}

// Props v2: a prop's in-game idle effect, chosen when it is queued (prop_fx)
// and copied to entity_types.idle_fx on approve. Props do not use actions.
export const PROP_FX_OPTIONS = [
  { id: 'none', label: 'None' },
  { id: 'sway', label: 'Sway' },
  { id: 'shine', label: 'Shine' },
];
const PROP_FX_IDS = new Set(PROP_FX_OPTIONS.map((o) => o.id));

export function propFxLabel(fx) {
  return (PROP_FX_OPTIONS.find((o) => o.id === fx) || PROP_FX_OPTIONS[0]).label;
}

// The effect a prop row will get on approve: its prop_fx, else none.
export function propEffect(subject) {
  return PROP_FX_IDS.has(subject?.prop_fx) ? subject.prop_fx : 'none';
}

export function selectionKinds(rows) {
  const props = rows.some((row) => spriteShape(row) === 'flat');
  const creatures = rows.some((row) => spriteShape(row) !== 'flat');
  return { props, creatures, propsOnly: props && !creatures };
}

// Selected rows + controls -> POST /jobs body. A props-only selection has no
// actions or frames to choose (the route still wants a valid action, so idle
// x1 stands in); prop_fx travels whenever a prop is selected.
export function queuePayload(catalog, rows, { actions, frames, propFx = 'none' }) {
  const { props, propsOnly } = selectionKinds(rows);
  const ids = (catalog?.actions || []).map((action) => action.id);
  const body = propsOnly
    ? { targets: targetsForSprites(rows), actions: ids.includes('idle') ? ['idle'] : ids.slice(0, 1), frames: 1 }
    : { targets: targetsForSprites(rows), actions, frames };
  if (props) body.prop_fx = propFx;
  return body;
}

// What the queue button will do to the selection: POST /jobs inserts rows
// with no live job, re-takes the options on queued ones, and leaves a running
// job alone (the box is drawing it). `actionable` is false when nothing would change.
export function queueButtonLabel(rows) {
  const update = rows.filter((row) => row.job_state === 'queued').length;
  const running = rows.filter((row) => row.job_state === 'running').length;
  const fresh = rows.length - update - running;
  const parts = [];
  if (fresh && update) parts.push(`Queue ${fresh} · update ${update}`);
  else if (update) parts.push(`Update ${update} queued`);
  else if (fresh || !running) parts.push(`Queue ${fresh} selected`);
  if (running) parts.push(`${running} running, unchanged`);
  return { label: parts.join(' · '), actionable: fresh + update > 0 };
}

export function estimateLabel(cells, secondsPerCell) {
  const noun = `${cells} cell${cells === 1 ? '' : 's'}`;
  const minutes = Math.round((cells * secondsPerCell) / 60);
  if (minutes < 1) return `${noun} · < 1 min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${noun} · ~${h ? `${h} h ` : ''}${h && !m ? '' : `${m} min`}`.trimEnd();
}

// Batch progress from the dispatcher's run: cell-weighted, the running row
// counting by its box percentage. leftLabel follows estimateLabel's style.
export function batchProgress(run) {
  const total = Number(run?.totalCells) || 0;
  if (!run || total <= 0) return { pct: 0, doneCells: 0, totalCells: total, leftLabel: '' };
  const cur = run.current;
  const partial = cur && cur.phase !== 'concept' ? (Number(cur.cells) || 0) * ((Number(cur.pct) || 0) / 100) : 0;
  const done = Math.min(total, (Number(run.doneCells) || 0) + partial);
  const minutes = Math.round(((total - done) * (Number(run.secondsPerCell) || 57)) / 60);
  let leftLabel = '< 1 min left';
  if (minutes >= 1) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    const span = h >= 10 ? `~${h} h` : `~${h ? `${h} h ` : ''}${h && !m ? '' : `${m} min`}`.trimEnd();
    leftLabel = `${span} left`;
  }
  return { pct: Math.round((done / total) * 100), doneCells: Math.floor(done), totalCells: total, leftLabel };
}

// What the running row is doing right now, from run.current.
export function currentProgressLabel(run) {
  const cur = run?.current;
  if (!cur) return '';
  if (cur.phase === 'concept') return 'making concept…';
  if (cur.phase === 'queued') return "waiting in the box's queue";
  if (cur.phase === 'storing') return 'storing…';
  const pct = `${Math.round(Number(cur.pct) || 0)}%`;
  return cur.message ? `${pct} · ${cur.message}` : pct;
}

// "running 37%" for the row the dispatcher is drawing (run.current.id is the
// sprite_sets id, i.e. the subject's job_id); null for every other row.
export function rowProgressLabel(subject, run) {
  const cur = run?.current;
  if (!cur || cur.phase !== 'running' || subject?.job_state !== 'running') return null;
  if (!subject.job_id || cur.id !== subject.job_id) return null;
  return `${subject.redraw_of ? 'redrawing' : 'running'} ${Math.round(Number(cur.pct) || 0)}%`;
}

// The queue has work in flight: a batch is running or rows are queued/running.
export function queueIsLive({ run, stats } = {}) {
  return Boolean(run?.running || stats?.queued || stats?.running);
}

// Live -> idle: the run just ended, so the (no longer polled) subjects list
// needs one last refresh to show the final row states.
export function runJustEnded(wasLive, isLive) {
  return wasLive === true && !isLive;
}

// Initial action ticks: idle, filtered to the catalog's ids. Props never
// add actions (their effect is the separate prop_fx select).
export function defaultActionsFor(catalog, _rows) {
  const ids = new Set((catalog?.actions || []).map((action) => action.id));
  return ['idle'].filter((id) => ids.has(id));
}

// sheet.json -> one label per sheet row. Legacy local atlases have no `rows`.
export function rowLabels(manifest) {
  if (!manifest || !Array.isArray(manifest.rows)) return [];
  return manifest.rows.map((r) => `row ${r.row} · ${r.action} · ${r.direction} · ${r.frames} frames`);
}
