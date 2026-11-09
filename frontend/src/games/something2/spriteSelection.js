import { PAGE_SIZE, clampPage, pageCount } from './artSelection.js';
import { NEW_ENTITY_DEFAULTS } from './newEntityDefaults.js';
import { durationLabel, boxSeconds, etaLabel, cellsOf, DEFAULT_SECONDS_PER_CELL } from './spriteEta.js';

// Effect rows (auras, bolts, impacts, beams) share the table but are neither:
// one strip, one direction, drawn on the box's effects lane.
export function spriteShape(subject) {
  if (subject.effect === true) return 'effect';
  return subject.is_creature || subject.is_playable ? 'directional' : 'flat';
}

export function hasSpriteVisual(subject) {
  return Boolean(subject.sprite || (subject.image && subject.render_mode !== 'rect'));
}

// What a column displays, broken into the values its filter can pick.
export function actionTokens(subject) {
  if (subject?.effect === true) return [subject.loop ? 'loop' : 'one-shot'];
  if (isBoxProp(subject) && subject.prop_fx) return [`effect: ${propFxLabel(subject.prop_fx)}`];
  return Array.isArray(subject?.actions) ? subject.actions : [];
}

export function directionTokens(subject) {
  return Array.isArray(subject?.directions) ? subject.directions : [];
}

// Split, so that picking gpu-box also finds "gpu-box · 3D".
export function backendTokens(subject) {
  return backendLabel(subject).split(' · ');
}

function matchesTokens(tokens, wanted) {
  if (wanted === 'all') return true;
  if (wanted === 'none') return tokens.length === 0;
  return tokens.includes(wanted);
}

const HOUR_MS = 3600 * 1000;
export const UPDATED_FILTERS = [
  { id: 'all', label: 'Any time' },
  { id: 'hour', label: 'Last hour', within: HOUR_MS },
  { id: 'day', label: 'Last 24 hours', within: 24 * HOUR_MS },
  { id: 'week', label: 'Last 7 days', within: 7 * 24 * HOUR_MS },
  { id: 'month', label: 'Last 30 days', within: 30 * 24 * HOUR_MS },
  { id: 'older', label: 'Older than 30 days' },
  { id: 'never', label: 'Never' },
];
const OLDER_THAN_MS = 30 * 24 * HOUR_MS;

function matchesUpdated(subject, updated, now) {
  if (updated === 'all') return true;
  const time = Date.parse(subject.job_updated_at);
  if (Number.isNaN(time)) return updated === 'never';
  if (updated === 'never') return false;
  if (updated === 'older') return now - time > OLDER_THAN_MS;
  return now - time <= UPDATED_FILTERS.find((choice) => choice.id === updated).within;
}

export const NO_COLUMN_FILTERS = { actions: 'all', directions: 'all', backend: 'all', updated: 'all' };

export function filterSpriteSubjects(subjects, {
  shape = 'all', status = 'missing', search = '', actions = 'all', directions = 'all', backend = 'all', updated = 'all', now = Date.now(),
} = {}) {
  const needle = search.trim().toLowerCase();
  return subjects.filter((subject) => {
    if (shape !== 'all' && spriteShape(subject) !== shape) return false;
    if (needle && !subject.name.toLowerCase().includes(needle)) return false;
    if (!matchesTokens(actionTokens(subject), actions)) return false;
    if (!matchesTokens(directionTokens(subject), directions)) return false;
    if (!matchesTokens(backendTokens(subject), backend)) return false;
    if (!matchesUpdated(subject, updated, now)) return false;
    if (status === 'missing') return !hasSpriteVisual(subject);
    if (status === 'none') return !subject.job_state;
    if (status !== 'all') return subject.job_state === status;
    return true;
  });
}

// A filter's options are what the rows hold. The selected value stays listed so
// a refresh that removes its last row cannot silently change what the select shows.
export function columnFilterChoices(subjects, tokensOf, current, order = null) {
  const found = new Set(subjects.flatMap(tokensOf));
  if (current !== 'all' && current !== 'none') found.add(current);
  const rank = (value) => {
    const index = order ? order.indexOf(value) : -1;
    return index === -1 ? Infinity : index;
  };
  return [...found].sort((a, b) => (rank(a) === rank(b) ? a.localeCompare(b) : rank(a) - rank(b)));
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


// Status sorts in the order the work moves, not alphabetically.
const STATUS_ORDER = ['running', 'queued', 'failed', 'done', 'approved'];

// Each sortable column's key: what the row displays. null = nothing to compare.
const SORT_KEYS = {
  shape: spriteShape,
  actions: (subject) => actionTokens(subject).join(' · ') || null,
  directions: (subject) => {
    const dirs = directionTokens(subject);
    return dirs.length ? `${dirs.length} ${dirs.join(' · ')}` : null;
  },
  backend: backendLabel,
  status: (subject) => {
    const index = STATUS_ORDER.indexOf(subject.job_state);
    return index === -1 ? null : index;
  },
  updated: (subject) => {
    const time = Date.parse(subject.job_updated_at);
    return Number.isNaN(time) ? null : time;
  },
};

// Newest first is what Last update is for; every other column starts ascending.
// Clicks cycle first direction, the other one, then back to the default order.
export function nextSpriteSort(sort, column) {
  const first = column === 'updated' ? 'desc' : 'asc';
  if (sort?.column !== column) return { column, dir: first };
  if (sort.dir === first) return { column, dir: first === 'asc' ? 'desc' : 'asc' };
  return null;
}

// Rows with nothing to compare stay last in BOTH directions: most of the table
// has never been queued, and would otherwise bury the rows being looked for.
export function sortSpriteSubjects(rows, sort) {
  if (!sort) return rows;
  const direction = sort.dir === 'desc' ? -1 : 1;
  const keyOf = SORT_KEYS[sort.column];
  const keyed = [];
  const empty = [];
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null) empty.push(row); else keyed.push({ row, key });
  }
  keyed.sort((a, b) => direction * (typeof a.key === 'number' ? a.key - b.key : a.key.localeCompare(b.key)));
  return [...keyed.map(({ row }) => row), ...empty];
}

export const COLUMN_HELP = {
  shape: 'directional: a creature or playable class, drawn per facing. flat: everything else.',
  actions: "Actions on the row's latest job. A prop made on the box shows its idle effect instead.",
  directions: "Facings the row's latest job draws. Sorts by how many, then which.",
  backend: "Where the row's latest job runs, plus its sampling preset and 3D when used. A never-queued row shows local.",
  status: "State of the row's latest job. Sorts in workflow order: running, queued, failed, done (ready for review), approved.",
  updated: "When the row's latest job last changed. Sorts newest first.",
};

export const TABLE_SORT_HINT = 'Click Shape, Actions, Directions, Backend, Status or Last update to sort all matching rows: click again to reverse, a third time for the default order. Rows with no value stay last. Hover a heading for what it shows.';
export const TABLE_FILTER_HINT = 'Filters combine, and Select all takes only the rows they leave. Actions, Directions and Backend match a row holding that value among others. The default Status, Missing visual, hides rows that already have art: use Any to see everything.';

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
// SPRITE_CELLS). 96x128 is the default the tab opens with; a job with no cell means 48x64 (legacy).
export const SPRITE_CELLS = [
  { id: '48x64', label: '48×64' },
  { id: '96x128', label: '96×128 (more detail)' },
];
export const DEFAULT_CELL = SPRITE_CELLS.find((c) => c.id === '96x128').id;

// The cell size a subject's latest sheet job asked for when it is not the
// default, else null (the Frames column then shows nothing extra).
// A NULL cell on a row with a sheet or job is a legacy 48x64 draw (binding legacy rule).
export function cellInfoLabel(subject) {
  const drawn = Boolean(subject?.atlas_key || subject?.manifest_key || subject?.job_id);
  const cell = subject?.cell || (drawn ? '48x64' : null);
  const found = SPRITE_CELLS.find((c) => c.id === cell);
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
export function queueBlockReason(rows, directions, { sheetMethod = null, actions = [] } = {}) {
  if (!selectionKinds(rows).creatures) return null;
  if (directions.length === 0) return 'Pick at least one direction';
  if (sheetMethod === 'turnaround3d' && !actions.includes('idle')) return 'The 3D turnaround replaces idle frames: tick Idle';
  const others = rows.filter((row) => hasBodyPlan(row) && row.body_plan === 'other').map((row) => row.name);
  if (others.length) return `No poses for these bodies yet, untick them or correct their Body: ${others.join(', ')}`;
  return null;
}

// SOMET-709: one sheet is a full action x direction grid, so a run with fewer
// directions than the current sheet makes a smaller sheet. Allowed, but said
// before Queue: one line per set of lost directions. Props have no directions,
// and a running job keeps the options it started with.
export function directionLossLines(rows, directions) {
  if (directions.length === 0) return [];
  const byLoss = new Map();
  for (const row of rows) {
    if (spriteShape(row) === 'flat' || row.job_state === 'running' || !Array.isArray(row.sheet_directions)) continue;
    const lost = SPRITE_DIRECTIONS.filter((d) => row.sheet_directions.includes(d) && !directions.includes(d));
    if (lost.length === 0) continue;
    const key = lost.join(', ');
    byLoss.set(key, [...(byLoss.get(key) || []), row.name]);
  }
  return [...byLoss].map(([lost, names]) => {
    const shown = names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ');
    return `${shown}: the new sheet will not have ${lost} (the current sheet does). Tick to include.`;
  });
}

// Body column: only non-player creatures have one; the rest draw as they always have.
export const BODY_PLAN_OPTIONS = [
  { value: '', label: 'Not set' },
  { value: 'humanoid', label: 'Two legs' },
  { value: 'quadruped', label: 'Four legs' },
  { value: 'other', label: 'Other (not drawn)' },
];

export function hasBodyPlan(subject) {
  return subject?.variant == null && subject?.is_creature === true && subject?.is_playable !== true;
}

// Who Detect asks about: the ticked creatures, unless an admin set them; with
// nothing ticked, the creatures in the current filter that have no body yet.
export function bodyDetectIds(selectedRows, matchingRows) {
  const rows = selectedRows.length
    ? selectedRows.filter((s) => hasBodyPlan(s) && s.body_plan_source !== 'admin')
    : matchingRows.filter((s) => hasBodyPlan(s) && !s.body_plan);
  return rows.map((s) => s.id);
}

export function chunkIds(ids, size = 40) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

// The Generation method options the chosen connector can run.
export function generationMethodsFor(catalog, engine = 'diffusers') {
  const methods = catalog?.generation_methods || [];
  return methods.filter((m) => (engine === 'comfyui-hq' ? m.hq : m.diffusers !== false));
}

// The chosen method, or the first one when the choice is not on offer (any more).
export function chosenMethod(methods, id) {
  return methods.find((m) => m.id === id) || methods[0] || null;
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
  if (subject?.kept_concept_key) return subject.kept_concept_regenerated ? 'Concept — regenerated' : 'Concept — reused';
  return 'New concept will be drawn';
}

// The table's Concept caption: what the NEXT run uses. A creature reuses its
// kept concept, else draws a new one (even when its last job used one that
// "New concept" has since forgotten). The preview keeps conceptLabelOf, which
// describes that job's own concept.
export function nextConceptCaption(subject) {
  if (isPropSubject(subject)) return conceptLabelOf(subject);
  if (!subject?.kept_concept_key) return 'New concept will be drawn';
  return subject.kept_concept_regenerated ? 'Concept — regenerated' : 'Concept — reused';
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
  // Regenerate: the text model writes the prompt before the box draws.
  if (subject?.job_state === 'queued' && subject?.needs_prompt === true) return 'prompt pending';
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
  const creatures = rows.some((row) => spriteShape(row) === 'directional');
  const effects = rows.some((row) => spriteShape(row) === 'effect');
  return {
    props, creatures, propsOnly: props && !creatures && !effects,
    effects, effectsOnly: effects && !props && !creatures, mixedEffects: effects && (props || creatures),
  };
}

// The rows that go to POST /jobs (creatures, heroes, props): everything but effects.
export function spriteRowsOf(rows) {
  return rows.filter((row) => spriteShape(row) !== 'effect');
}

export function effectRowsOf(rows) {
  return rows.filter((row) => spriteShape(row) === 'effect');
}

const ONE_DIRECTION = 'effects have one direction';

// Which controls a selection gets (spec §2.2). Effects are one strip in one
// direction: an effects-only selection greys facings and cell and offers the
// effect frames/loop instead. A mixed selection keeps the creature controls
// (they apply to its creature rows) and leaves every effect row at its defaults.
export function selectionControls(rows) {
  const k = selectionKinds(rows);
  const effectLoop = { shown: false, locked: false, value: null, title: '' };
  if (k.effectsOnly) {
    const fx = effectRowsOf(rows);
    const bursts = fx.filter((r) => r.kind === 'burst').length;
    const auras = fx.filter((r) => r.kind === 'aura').length;
    const locked = bursts + auras === fx.length;
    let title = '';
    if (bursts && auras) title = 'bursts always play once; auras always loop';
    else if (bursts) title = 'bursts always play once';
    else if (auras) title = 'auras always loop';
    let value = null;
    if (locked && !auras) value = false;
    else if (locked && !bursts) value = true;
    return {
      facings: { disabled: true, title: ONE_DIRECTION },
      cell: { disabled: true, title: ONE_DIRECTION },
      creatureActions: false,
      effectFrames: true,
      effectLoop: { shown: true, locked, value, title },
    };
  }
  // Props + effects with no creature: nothing for the creature controls to act on.
  if (k.effects && !k.creatures) {
    return {
      facings: { disabled: true, hidden: true, title: 'no creature rows selected' },
      cell: { disabled: true, hidden: true, title: 'no creature rows selected' },
      creatureActions: false,
      effectFrames: false,
      effectLoop,
    };
  }
  const title = k.mixedEffects ? 'applies to creature rows only' : '';
  return {
    facings: { disabled: false, title },
    cell: { disabled: false, title },
    creatureActions: true,
    effectFrames: false,
    effectLoop,
  };
}

// The most frames every selected effect allows (mirrors the backend's
// effectMaxFrames: a strip is at most 8192 px wide and a beam cell is 4x its size).
const MAX_EFFECT_FRAMES = 64;
const MAX_STRIP_WIDTH = 8192;
export function effectMaxFramesOf(row) {
  if (Number.isInteger(row?.max_frames) && row.max_frames > 0) return row.max_frames;
  const size = Number(row?.size) || 0;
  if (!(size > 0)) return MAX_EFFECT_FRAMES;
  return Math.min(MAX_EFFECT_FRAMES, Math.floor(MAX_STRIP_WIDTH / (row.kind === 'beam' ? size * 4 : size)));
}
export function effectFramesCap(rows) {
  const caps = effectRowsOf(rows).map(effectMaxFramesOf);
  return caps.length ? Math.min(...caps) : MAX_EFFECT_FRAMES;
}

// POST /effects/jobs body. frames only when picked; loop only for the kinds that
// can choose (a burst always plays once, an aura always loops: never sent).
// `prompts` holds the effect prompts the admin edited in this session (row id ->
// text); every other row sends no prompt and the server resolves it.
export function effectQueuePayload(rows, { frames = null, loop = null, regenerate = false, prompts = {} } = {}) {
  const targets = effectRowsOf(rows).map((row) => {
    const t = { subject_kind: row.subject_kind, name: row.name };
    if (Number.isInteger(frames)) t.frames = frames;
    if (typeof loop === 'boolean' && (row.kind === 'projectile' || row.kind === 'beam')) t.loop = loop;
    const text = prompts[row.id];
    if (typeof text === 'string' && text.trim()) t.prompt = text.trim();
    return t;
  });
  const body = { targets };
  if (regenerate) body.regenerate = true;
  return body;
}

// The server refuses an edited effect prompt together with Regenerate (the
// regenerated prompt would throw the edit away): say so before Queue.
export function effectPromptConflict(rows, prompts, regenerate) {
  if (!regenerate) return null;
  const names = effectRowsOf(rows).filter((row) => typeof prompts?.[row.id] === 'string' && prompts[row.id].trim()).map((row) => row.name);
  return names.length ? `Prompt edited for ${names.join(', ')}: untick Regenerate prompt to draw the edit` : null;
}

// One Queue press: creature/prop rows -> POST /jobs, effect rows -> POST
// /effects/jobs. An empty side sends nothing. Only an effects-only selection
// sends the effect frames/loop; a mixed one leaves the effects at their defaults.
export function queueRequests(catalog, rows, { regenerate = false, effectFrames = null, effectLoop = null, effectPrompts = {}, ...options } = {}) {
  const sprites = spriteRowsOf(rows);
  const fx = effectRowsOf(rows);
  const out = [];
  if (sprites.length) out.push({ path: '/jobs', body: queuePayload(catalog, sprites, { ...options, regenerate }) });
  if (fx.length) {
    const only = sprites.length === 0;
    out.push({
      path: '/effects/jobs',
      body: effectQueuePayload(fx, { frames: only ? effectFrames : null, loop: only ? effectLoop : null, regenerate, prompts: effectPrompts }),
    });
  }
  return out;
}

// Which row ids each Queue request carries (same split as queueRequests).
export function queueLaneIds(rows) {
  return { '/jobs': spriteRowsOf(rows).map((r) => r.id), '/effects/jobs': effectRowsOf(rows).map((r) => r.id) };
}

export const QUEUE_LANE_LABEL = { '/jobs': 'Creatures: ', '/effects/jobs': 'Effects: ' };

// After a Queue press: drop the rows of every lane that succeeded from the
// selection (a retry must not re-send them: Regenerate would rewrite prompts it
// just wrote, an effect re-queue could cancel a picked-up box job); keep the
// rows of a lane that failed so the admin can retry just that lane.
export function settleQueueResults(selected, requests, results, laneIds) {
  const next = new Set(selected);
  const succeededIds = [];
  const failed = [];
  requests.forEach((r, i) => {
    if (results[i]?.status === 'fulfilled') {
      for (const id of laneIds[r.path] || []) { next.delete(id); succeededIds.push(id); }
    } else failed.push(r.path);
  });
  return { selected: next, succeededIds, failed };
}

// Force keeps a concept drawn from a Sprite-tab prompt (owner decision); say so.
export function forceKeepsConceptHint(rows) {
  const names = spriteRowsOf(rows).filter((row) => !isPropSubject(row) && row.kept_concept_key && row.kept_concept_regenerated === true).map((row) => row.name);
  if (!names.length) return null;
  return names.length === 1
    ? `${names[0]} keeps its regenerated concept — use Regenerate prompt for a fresh one`
    : `${names.join(', ')} keep their regenerated concepts — use Regenerate prompt for fresh ones`;
}

// Selected rows + controls -> POST /jobs body. A props-only selection has no
// actions or frames to choose (the route still wants a valid action, so idle
// x1 stands in). prop_fx travels only when the admin picked one: left out, the
// server decides per prop (SOMET-677: trees drift, other props stay still).
export function queuePayload(catalog, rows, { actions, frames, propFx = '', directions, cell, redrawActions = false, providerId = null, sampling = null, sheetMethod = null, qualityChecks = null, regenerate = false }) {
  const { props, propsOnly } = selectionKinds(rows);
  const ids = (catalog?.actions || []).map((action) => action.id);
  const body = propsOnly
    ? { targets: targetsForSprites(rows), actions: ids.includes('idle') ? ['idle'] : ids.slice(0, 1), frames: 1 }
    : { targets: targetsForSprites(rows), actions, frames };
  if (props && propFx) body.prop_fx = propFx;
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
  // Sent even for '2d': a connector set to 3D must not override the choice made here.
  if (!propsOnly && sheetMethod) body.sheet_method = sheetMethod;
  // The box's own frame checks: sent as chosen (false by default); null = not sent (HQ never sends it).
  if (!propsOnly && qualityChecks != null) body.quality_checks = Boolean(qualityChecks);
  // Regenerate prompt: props have no prompt lane, so a props-only press never sends it.
  if (!propsOnly && regenerate) body.regenerate = true;
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

export function estimateLabel(cells, secondsPerCell) {
  return `${cells} cell${cells === 1 ? '' : 's'} · ${durationLabel(cells * secondsPerCell)}`;
}

// Actions a four-legged row cannot do (mirrors the backend's QUADRUPED_EXCLUDED_ACTIONS).
const QUADRUPED_EXCLUDED = ['cast', 'use'];

export function actionsForRow(row, actions) {
  if (row?.body_plan !== 'quadruped') return actions;
  const kept = actions.filter((a) => !QUADRUPED_EXCLUDED.includes(a));
  return kept.length ? kept : ['idle'];
}

// Box seconds for the creature rows of a selection, summed row by row (each
// row is its own sheet job). selection: { rows, actions, directions, frames,
// secondsPerCell?, engine? } -- secondsPerCell overrides the method's rate (HQ
// connector). On the HQ engine (engine 'comfyui-hq') a preset method takes its
// own hq_seconds_per_cell; the box default (no sampling) takes the connector's rate.
export function selectionBoxSeconds(method, selection, etaModel, qualityChecks) {
  const hqRate = selection.engine === 'comfyui-hq' && method?.sampling ? Number(method.hq_seconds_per_cell) : 0;
  const secondsPerCell = hqRate || Number(selection.secondsPerCell) || Number(method?.eta_seconds_per_cell) || Number(selection.fallbackSecondsPerCell);
  const total = { low: 0, typical: 0, high: 0 };
  let creatures = 0;
  if (!(secondsPerCell > 0)) return null;
  for (const row of selection.rows || []) {
    if (spriteShape(row) !== 'directional') continue;
    creatures += 1;
    const t = boxSeconds({
      actions: actionsForRow(row, selection.actions || []),
      directions: selection.directions, frames: selection.frames, secondsPerCell, qualityChecks,
    }, etaModel || undefined);
    for (const k of Object.keys(total)) total[k] += t[k];
  }
  return creatures ? total : null;
}

// Generation method option: the method name plus the box time for the whole
// selection; a range when the box's own quality checks are on.
export function methodOptionLabel(method, selection, etaModel, qualityChecks) {
  const total = selectionBoxSeconds(method, selection || {}, etaModel, qualityChecks);
  return total ? `${method.label} — ${etaLabel(total)}` : method.label;
}

// Cells of the selection counted the way the ETA counts them: per row, quadruped
// action drop and mirrored west facings applied; a flat prop is 1 cell.
export function selectionCells(selection) {
  return (selection.rows || []).reduce((sum, row) => sum + (spriteShape(row) === 'flat' ? 1
    : cellsOf({ actions: actionsForRow(row, selection.actions || []), directions: selection.directions, frames: selection.frames })), 0);
}

// The queue estimate line for the same selection ('' when there is nothing to estimate).
export function selectionEtaLabel(method, selection, etaModel, qualityChecks) {
  const total = selectionBoxSeconds(method, selection || {}, etaModel, qualityChecks);
  return total ? etaLabel(total) : '';
}

// The whole press: creature box seconds + effect strips + the prompt phase.
// Each lane with prompts to write pays one text-model switch plus per-prompt seconds.
export function selectionTotalEta({ boxSeconds: box = null, effectEta = null, prompts = {}, promptEta = null } = {}) {
  const out = { low: 0, typical: 0, high: 0 };
  for (const part of [box, effectEta]) {
    if (!part) continue;
    for (const k of Object.keys(out)) out[k] += Number(part[k]) || 0;
  }
  let n = 0;
  for (const count of [prompts.sprite, prompts.effect]) {
    const c = Number(count) || 0;
    if (c <= 0 || !promptEta) continue;
    n += c;
    const lane = (Number(promptEta.switch_seconds) || 0) + c * (Number(promptEta.per_prompt_seconds) || 0);
    for (const k of Object.keys(out)) out[k] += lane;
  }
  return { ...out, placeholder: Boolean(promptEta?.placeholder) && n > 0 };
}

export function totalEtaLabel(est) {
  return `${etaLabel(est)}${est?.placeholder ? ' (prompt time is an estimate, not yet measured)' : ''}`;
}

// The Queue estimate line. creatureUnknown: creatures are selected but their
// box rate is not known; with nothing else to add up, say only that.
export function queueEtaText(est, creatureUnknown = false) {
  if (creatureUnknown && !(Number(est?.high) > 0)) return 'no time estimate';
  return `${totalEtaLabel(est)}${creatureUnknown ? ' · creatures: no time estimate' : ''}`;
}

// Finished row: how long the box took against what was predicted.
export function tookLabel({ sheet_seconds: took, predicted_seconds: predicted } = {}) {
  if (!(Number(took) > 0)) return null;
  const strip = (s) => durationLabel(s).replace(/^~/, '');
  return Number(predicted) > 0 ? `took ${strip(took)} (est. ${strip(predicted)})` : `took ${strip(took)}`;
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
  const rate = Number(run.secondsPerCell) || DEFAULT_SECONDS_PER_CELL;
  const curCells = cur ? Number(cur.cells) || 0 : 0;
  // The running row's remaining time is its predicted box seconds left (the ETA
  // formula, fixed overhead included); a row without one counts cells x rate.
  const curLeft = Number(cur?.predictedSeconds) > 0
    ? Number(cur.predictedSeconds) * (1 - Math.min(100, Math.max(0, Number(cur.pct) || 0)) / 100)
    : Math.max(0, curCells - partial) * (Number(cur?.secondsPerCell) || rate);
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

// SOMET-721: a running row with no live run was left behind by a backend restart.
export function batchHeadline({ run, stats } = {}) {
  if (run?.running) return { title: 'Batch running', hint: '' };
  // SOMET-756: the run ended itself because the box did not answer.
  if (run?.endedReason) return { title: 'Batch ended: box unreachable', hint: run.endedReason };
  if (stats?.running) {
    return {
      title: 'Batch interrupted',
      hint: 'The backend restarted during this batch. Once the GPU box is reachable, press Rescue stranded, then Start batch. Rescue skips a row claimed in the last minute, so press it again if nothing moves.',
    };
  }
  return { title: 'Batch idle', hint: '' };
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

// Initial action ticks: the seven creature actions, filtered to the catalog's
// ids. A props-only selection keeps idle (a prop's effect is the separate
// prop_fx select). A quadruped row drops cast/use at queue time, server-side.
export const DEFAULT_CREATURE_ACTIONS = ['idle', 'walk', 'attack', 'cast', 'damage', 'death', 'use'];
export function defaultActionsFor(catalog, rows) {
  const ids = new Set((catalog?.actions || []).map((action) => action.id));
  const list = rows?.length && rows.every((row) => spriteShape(row) === 'flat') ? ['idle'] : DEFAULT_CREATURE_ACTIONS;
  return list.filter((id) => ids.has(id));
}

// sheet.json -> one label per sheet row. Legacy local atlases have no `rows`.
export function rowLabels(manifest) {
  if (!manifest || !Array.isArray(manifest.rows)) return [];
  return manifest.rows.map((r) => `row ${r.row} · ${r.action} · ${r.direction} · ${r.frames} frames`);
}

// GPU-box cancels still open (SOMET-695): one batch-card line per row.
export function boxCancelLines(boxCancels) {
  return (boxCancels || []).map((row) => {
    if (row.send_error) {
      return { id: row.id, text: `The cancel did not reach the GPU box (${row.subject || 'unknown subject'}): ${row.send_error}`, retry: true };
    }
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

// New creature form (SOMET-699). Starts from the Entities tab's new-entity
// defaults, not the route's, whose zeros store a 0/0 HP creature. Grey is a
// placeholder: the sprite replaces it.
export function newCreatureError(name) {
  return String(name ?? '').trim() ? null : 'Name is required';
}

export function newCreatureBody({ name, prompt, shape }) {
  const text = String(prompt ?? '').trim();
  return {
    ...NEW_ENTITY_DEFAULTS,
    name: String(name ?? '').trim(),
    ...(text ? { prompt: text } : {}),
    color: '#808080',
    is_creature: shape === 'creature',
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
  if (subject && subject.sheet_method === 'turnaround3d') parts.push('3D');
  return parts.join(' · ');
}

// SOMET-712: the connector a queue press uses: the chosen one if it is still
// listed, else the active one, else the first; null when there are none.
export function chosenConnector(list, chosenId) {
  if (!Array.isArray(list) || list.length === 0) return null;
  return list.find((c) => c.id === chosenId) || list.find((c) => c.is_active) || list[0];
}

// The wait already on the box (GET /box-queue), shown beside the selection's
// own estimate. Informational only: it never gates queuing.
export function waitLabel(queue) {
  const ahead = queue && queue.ahead_seconds;
  if (!Number.isFinite(ahead)) return 'box queue unknown';
  const sw = queue.switch_seconds_max > 0 ? ` · + up to ${Math.round(queue.switch_seconds_max / 60)} min model switch` : '';
  return `${durationLabel(ahead)} waiting on the box${sw}`;
}
