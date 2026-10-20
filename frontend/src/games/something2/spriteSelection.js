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

const FACINGS = { directional: 8, flat: 1 };

export function framesCap(catalog, actions) {
  const caps = (catalog?.actions || [])
    .filter((action) => actions.includes(action.id))
    .map((action) => action.max_frames);
  return caps.length ? Math.min(...caps) : catalog?.max_frames ?? 1;
}

export function cellCount(rows, actions, frames) {
  return rows.reduce((sum, row) => sum + FACINGS[spriteShape(row)] * actions.length * frames, 0);
}

export function estimateLabel(cells, secondsPerCell) {
  const noun = `${cells} cell${cells === 1 ? '' : 's'}`;
  const minutes = Math.round((cells * secondsPerCell) / 60);
  if (minutes < 1) return `${noun} · < 1 min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${noun} · ~${h ? `${h} h ` : ''}${h && !m ? '' : `${m} min`}`.trimEnd();
}

// Initial action ticks: idle, plus sway when the current selection contains a
// flat prop (creatures have no sway). Filtered to the catalog's ids.
export function defaultActionsFor(catalog, rows) {
  const ids = new Set((catalog?.actions || []).map((action) => action.id));
  const wanted = (rows || []).some((row) => spriteShape(row) === 'flat') ? ['idle', 'sway'] : ['idle'];
  return wanted.filter((id) => ids.has(id));
}

// sheet.json -> one label per sheet row. Legacy local atlases have no `rows`.
export function rowLabels(manifest) {
  if (!manifest || !Array.isArray(manifest.rows)) return [];
  return manifest.rows.map((r) => `row ${r.row} · ${r.action} · ${r.direction} · ${r.frames} frames`);
}
