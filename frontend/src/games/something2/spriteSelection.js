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

// The eight facings a box sheet can be drawn in, in compass order (the backend's
// SPRITE_ALL_DIRECTIONS). A sheet draws only the chosen ones (SOMET-686).
export const SPRITE_DIRECTIONS = ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'];
export const DIRECTION_PRESETS = { 2: ['s', 'e'], 4: ['s', 'e', 'n', 'w'], 8: [...SPRITE_DIRECTIONS] };
// What a batch draws unless the admin picks otherwise (matches the backend default).
export const DEFAULT_DIRECTIONS = ['s', 'e', 'n'];

// SOMET-706: the cell sizes a sheet can be drawn at (mirrors the backend's
// SPRITE_CELLS). The first is the default and what a job with no cell means.
export const SPRITE_CELLS = [
  { id: '48x64', label: '48×64' },
  { id: '96x128', label: '96×128 (more detail)' },
];
export const DEFAULT_CELL = SPRITE_CELLS[0].id;

// The cell size a subject's latest sheet job asked for when it is not the
// default, else null (the Frames column then shows nothing extra).
export function cellInfoLabel(subject) {
  const found = SPRITE_CELLS.find((c) => c.id === subject?.cell);
  return found && found.id !== DEFAULT_CELL ? found.label.replace(/ \(.*\)$/, '') : null;
}

export function toggleDirection(dirs, id) {
  const next = new Set(dirs);
  if (next.has(id)) next.delete(id); else next.add(id);
  return SPRITE_DIRECTIONS.filter((d) => next.has(d));
}

export function presetOf(dirs) {
  const key = Object.keys(DIRECTION_PRESETS).find((n) => {
    const preset = DIRECTION_PRESETS[n];
    return preset.length === dirs.length && preset.every((d) => dirs.includes(d));
  });
  return key ? Number(key) : null;
}

export function hasWestern(dirs) {
  return dirs.some((d) => d === 'w' || d === 'nw' || d === 'sw');
}

// Why Queue is blocked by the direction choice, else null. Props ignore directions.
export function queueBlockReason(rows, directions) {
  return selectionKinds(rows).creatures && directions.length === 0 ? 'Pick at least one direction' : null;
}

// The Directions column: what the subject's latest job was drawn in. No
// "(real west)" suffix: the box always mirrors w/nw/sw (SOMET-705), whatever
// the row's real_western flag says.
export function directionsLabel(subject) {
  if (!Array.isArray(subject?.directions) || subject.directions.length === 0) return '—';
  return subject.directions.join(' · ');
}

export function framesCap(catalog, actions) {
  const caps = (catalog?.actions || [])
    .filter((action) => actions.includes(action.id))
    .map((action) => action.max_frames);
  return caps.length ? Math.min(...caps) : catalog?.max_frames ?? 1;
}

// A flat prop is one txt2img cutout on the box (Props v2, SOMET-657:
// one static image, animated by the game's idle effect), so it counts as 1 cell whatever the
// actions and frames; a creature is a sheet of facings x actions x frames.
export function cellCount(rows, actions, frames, directions = DEFAULT_DIRECTIONS) {
  return rows.reduce(
    (sum, row) => sum + (spriteShape(row) === 'flat' ? 1 : directions.length * actions.length * frames),
    0,
  );
}

// A GPU-box prop row made the Props v2 way: one generated cutout image, no sheet. A box
// prop done before Props v2 still carries a sheet (atlas_key) and previews as one.
// The image a row was (or would be) drawn from: the box concept once
// generated, else a hero appearance's own art, else the entity's existing art.
// A prop never uses a kept concept. generation_kind (from the latest job)
// decides when present, so an entity whose shape changed after its job still
// labels that job's art right; a never-queued subject has none, so its shape decides.
export function isPropSubject(subject) {
  if (subject?.generation_kind === 'creature') return false;
  if (subject?.generation_kind === 'object') return true;
  return isBoxProp(subject) || spriteShape(subject || {}) === 'flat';
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

// The table's Concept caption: what the NEXT run uses. A creature reuses its
// kept concept, else draws a new one (even when its last job used one that
// "New concept" has since forgotten). The preview keeps conceptLabelOf, which
// describes that job's own concept.
export function nextConceptCaption(subject) {
  if (isPropSubject(subject)) return conceptLabelOf(subject);
  return subject?.kept_concept_key ? 'Concept — reused' : 'New concept will be drawn';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n) => String(n).padStart(2, '0');

// The Last update column: local "23 Oct 01:12", the raw ISO as the hover title.
export function lastUpdateLabel(iso) {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return { text: '—', title: '' };
  return {
    text: `${date.getDate()} ${MONTHS[date.getMonth()]} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`,
    title: String(iso),
  };
}

export function newConceptConfirmText(n) {
  return `Forget the kept concept for ${n} subject${n === 1 ? '' : 's'}? The next run draws a new one.`;
}

export function deleteConfirmText(n) {
  return `Delete all generated sprites for ${n} subject${n === 1 ? '' : 's'}? Sheets, redraws and queued jobs are removed; concepts are kept. This cannot be undone.`;
}

export function forceConfirmText(n) {
  return `Force regenerate ${n} subject(s)? Their kept concept and any unapproved sheets are deleted and drawn again from scratch. Approved art stays until you approve the new sheet.`;
}

// POST /jobs/force `refused` -> one "Name: reason" line each, named from the selected rows.
export function refusedLines(refused, rows) {
  const names = new Map(targetsForSprites(rows || []).map((t, i) => [`${t.entity_id}:${t.variant ?? ''}`, rows[i].name]));
  return (refused || []).map((r) => `${names.get(`${r.entity_id}:${r.variant ?? ''}`) || (r.variant == null ? r.entity_id : `${r.entity_id}:${r.variant}`)}: ${r.reason}`);
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
  { id: 'drift', label: 'Drift' },
];
// SOMET-677: what a newly queued prop gets unless the admin picks another.
export const DEFAULT_PROP_FX = 'drift';
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
export function queuePayload(catalog, rows, { actions, frames, propFx = DEFAULT_PROP_FX, directions, cell, redrawActions = false, providerId = null, sampling = null }) {
  const { props, propsOnly } = selectionKinds(rows);
  const ids = (catalog?.actions || []).map((action) => action.id);
  const body = propsOnly
    ? { targets: targetsForSprites(rows), actions: ids.includes('idle') ? ['idle'] : ids.slice(0, 1), frames: 1 }
    : { targets: targetsForSprites(rows), actions, frames };
  if (props) body.prop_fx = propFx;
  // Only an omitted key means "default"; null is a 400, so never send it.
  if (!propsOnly && directions?.length) body.directions = directions;
  // Props ignore the cell size (one txt2img image); the console always passes the chosen one for creatures.
  if (!propsOnly && cell) body.cell = cell;
  // SOMET-711: draw the chosen actions again even where the sheet has them; omitted = false.
  if (!propsOnly && redrawActions) body.redraw_actions = true;
  // SOMET-712: the sprite connector chosen for this press (creatures only).
  if (!propsOnly && providerId != null) body.provider_id = providerId;
  // Sampling preset (steps/cfg on the box); omitted = the box default.
  if (!propsOnly && sampling) body.sampling = sampling;
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

export const ESTIMATE_REUSE_HINT = 'cells already drawn from the same concept are reused at run time';

function durationLabel(seconds) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return '< 1 min';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `~${h ? `${h} h ` : ''}${h && !m ? '' : `${m} min`}`.trimEnd();
}

export function estimateLabel(cells, secondsPerCell) {
  return `${cells} cell${cells === 1 ? '' : 's'} · ${durationLabel(cells * secondsPerCell)}`;
}

// Sampling presets (catalog.sampling_presets): the box default runs at the
// connector's measured rate; a preset carries the box's own measured rate (Q6_K,
// and CFG above 1 adds a negative pass per step, so it roughly doubles the work).
// On the HQ engine every preset (Fast too) has the box's measured HQ rate.
export function presetSecondsPerCell(preset, secondsPerCell, engine = 'diffusers') {
  if (engine === 'comfyui-hq') return Number(preset?.hq_seconds_per_cell) || secondsPerCell;
  return Number(preset?.seconds_per_cell) || secondsPerCell;
}

export function samplingOptionLabel(preset, cells, secondsPerCell, engine = 'diffusers') {
  const quant = preset.quant ? `, ${preset.quant.toUpperCase()}` : '';
  const head = `${preset.label} — ${preset.steps} steps, cfg ${preset.cfg}${quant}`;
  if (!(cells > 0)) return head;
  return `${head} · ${durationLabel(cells * presetSecondsPerCell(preset, secondsPerCell, engine))}`;
}

// Batch progress from the dispatcher's run: cell-weighted, the running row
// counting by its box percentage. leftLabel follows estimateLabel's style.
// Time left: the running row at its own rate (a preset runs 2-4x the Fast
// history rate) plus the queued rows' own-rate seconds when the run reports them.
export function batchProgress(run) {
  const total = Number(run?.totalCells) || 0;
  if (!run || total <= 0) return { pct: 0, doneCells: 0, totalCells: total, leftLabel: '' };
  const cur = run.current;
  const partial = cur && cur.phase !== 'concept' ? (Number(cur.cells) || 0) * ((Number(cur.pct) || 0) / 100) : 0;
  const done = Math.min(total, (Number(run.doneCells) || 0) + partial);
  const rate = Number(run.secondsPerCell) || 57;
  const curCells = cur ? Number(cur.cells) || 0 : 0;
  const curLeft = Math.max(0, curCells - partial) * (Number(cur?.secondsPerCell) || rate);
  const rest = Math.max(0, total - (Number(run.doneCells) || 0) - curCells);
  const restSeconds = Number.isFinite(Number(run.queuedSeconds)) && run.queuedSeconds != null
    ? Number(run.queuedSeconds) : rest * rate;
  const minutes = Math.round((curLeft + restSeconds) / 60);
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

// GPU-box cancels still open (SOMET-695): one batch-card line per row.
export function boxCancelLines(boxCancels) {
  return (boxCancels || []).map((row) => {
    const progress = row.last_progress || 'no progress reported';
    return row.state === 'still_drawing'
      ? { id: row.id, text: `The GPU box is still drawing a cancelled job (${row.subject || 'unknown subject'}, ${progress}) — it ignored the cancel`, retry: true }
      : { id: row.id, text: `Stopping on the GPU box… (${progress})`, retry: false };
  });
}

export function startBatchWarning(boxCancels) {
  const first = (boxCancels || [])[0];
  return first ? `The GPU box is still busy with a cancelled job (${first.subject || 'unknown subject'}); new work waits behind it.` : null;
}

// New creature form (SOMET-699). POST /api/entity-types needs name + color;
// the rest take the route's own defaults. Grey is a placeholder: the sprite replaces it.
export function newCreatureError(name) {
  return String(name ?? '').trim() ? null : 'Name is required';
}

export function newCreatureBody({ name, prompt, shape }) {
  const text = String(prompt ?? '').trim();
  return {
    name: String(name ?? '').trim(),
    ...(text ? { prompt: text } : {}),
    color: '#808080',
    is_creature: shape === 'creature',
    render_mode: 'static',
  };
}

// The box always builds w/nw/sw by flipping e/ne/se (MIRROR_WEST); real west views cannot be drawn today.
export const WEST_MIRROR_HINT = 'west rows (w, nw, sw) are mirrors of the east rows on this box';

// SOMET-712: the Backend column, marking rows drawn by the HQ (ComfyUI) lane.
export function backendLabel(subject) {
  const base = (subject && subject.backend) || 'local';
  const parts = [base];
  if (subject && subject.provider_engine === 'comfyui-hq') parts.push('HQ');
  if (subject && subject.sampling) parts.push(subject.sampling);
  return parts.join(' · ');
}

// SOMET-712: the connector a queue press uses: the chosen one if it is still
// listed, else the active one, else the first; null when there are none.
export function chosenConnector(list, chosenId) {
  if (!Array.isArray(list) || list.length === 0) return null;
  return list.find((c) => c.id === chosenId) || list.find((c) => c.is_active) || list[0];
}
