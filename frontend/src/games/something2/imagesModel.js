// Pure helpers for the Images admin tab (no React, no fetch).

// Web-copy size as a fraction of the original, measured in the spike.
const RATIO = { entity: 0.053, item: 0.10, tile: 0.073, appearance: 0.05 };
const SHEET_RATIO = 0.44;
const FALLBACK_RATIO = 0.1; // icons (art:*) and any kind we have no measurement for
const DEFAULT_EDGE = { entity: 256, tile: 256, appearance: 384, item: 128 };

export const isSheet = (kind) => typeof kind === 'string' && (kind.endsWith('_sheet') || kind.startsWith('effect:'));

export function ratioFor(kind) {
  if (isSheet(kind)) return SHEET_RATIO;
  return RATIO[kind] ?? FALLBACK_RATIO;
}

// paramsByKind: optional per-kind overrides ({maxEdge} or {scale}); an override smaller than the
// preset lowers the estimate by area (a larger one never raises it past the preset ratio).
export function estimateWebBytes(rows, paramsByKind = {}) {
  let total = 0;
  for (const r of rows || []) {
    if (!Number.isFinite(r?.bytes)) continue;
    let f = 1;
    const p = paramsByKind?.[r.kind];
    if (p && isSheet(r.kind) && Number.isFinite(p.scale)) f = Math.min(1, p.scale ** 2);
    else if (p && Number.isFinite(p.maxEdge)) f = Math.min(1, (p.maxEdge / (DEFAULT_EDGE[r.kind] || 256)) ** 2);
    total += r.bytes * ratioFor(r.kind) * f;
  }
  return total;
}

// The footer's batch override applies to every selected kind (the backend uses one params
// object for the whole run), as estimateWebBytes' per-kind map.
export function overrideByKind(rows, params) {
  if (!params) return {};
  const out = {};
  for (const r of rows || []) if (r?.kind) out[r.kind] = params;
  return out;
}

// True when the run poll shows a run that has just ended: the previous poll saw it running, or
// it is a different run that started and finished between polls. `prev` undefined = never
// polled (the table loads itself). Refreshing on every non-running refetch re-ran the heavy list.
export function runFinished(prev, next) {
  if (!next || next.status === 'running' || prev === undefined) return false;
  if (!prev) return true;
  return prev.status === 'running' || prev.id !== next.id;
}

// History label: the auto-shrink sweep logs its ops with params.auto.
export const opLabel = (o) => (o?.params?.auto === true ? `${o.op} · auto` : o?.op);

// The game setting `image_auto_shrink` from /api/settings rows; default on.
export function autoShrinkOn(settings) {
  const row = (settings || []).find((s) => s.key === 'image_auto_shrink');
  return row ? row.value !== false : true;
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1000) return `${Math.round(n)} B`;
  if (n < 1_000_000) return `${Math.round(n / 1000)} KB`;
  return `${(n / 1_000_000).toFixed(1)} MB`;
}

export const subjectId = (row) => `${row.subject.table}\u0000${row.subject.key}\u0000${row.subject.column}`;
export const pagesOf = (items, size, page) => items.slice(page * size, page * size + size);
export const canShrink = (row) => row.state === 'original' || row.state === 'stale' || row.state === 'undone';
export const canUndo = (row) => row.state === 'shrunk';
export const canReactivate = (row) => row.state === 'undone';

// The selected rows a footer batch button acts on: Undo only rows serving a web copy; Shrink
// only rows that are not freshly shrunk -- unless the admin set an override (params), which
// re-shrinks shrunk rows too.
export function batchTargets(op, rows, params) {
  const list = rows || [];
  if (op === 'undo') return list.filter(canUndo);
  return params ? list : list.filter(canShrink);
}

// The "Larger than" filter refetches the whole (heavy) list: wait for typing to pause.
export const MIN_KB_DEBOUNCE_MS = 400;

// fn called once, `ms` after the last call(...args); cancel() drops a pending call.
export function debounce(fn, ms) {
  let timer = null;
  return {
    call(...args) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; fn(...args); }, ms);
    },
    cancel() { if (timer) clearTimeout(timer); timer = null; },
  };
}

// Bytes players load for these rows now: the web copy's size for a shrunk row, else the original.
export function servedBytes(rows) {
  let total = 0;
  for (const r of rows || []) {
    const web = r?.state === 'shrunk' ? r.variant?.web_bytes : null;
    if (Number.isFinite(web)) total += web;
    else if (Number.isFinite(r?.bytes)) total += r.bytes;
  }
  return total;
}

// Turn the override form ({maxEdge, scale, quality} as strings) into request params for these rows.
// -> {params: null} (nothing overridden: send none), {params}, or {error}. The backend refuses
// params that lack the field a selected kind needs (maxEdge for images, scale for sheets).
export function buildParams(rows, form = {}) {
  const num = (v) => (v === '' || v == null ? null : Number(v));
  const maxEdge = num(form.maxEdge);
  const scale = num(form.scale);
  const quality = num(form.quality);
  if (maxEdge == null && scale == null && quality == null) return { params: null };
  const needEdge = rows.some((r) => !isSheet(r.kind));
  const needScale = rows.some((r) => isSheet(r.kind));
  const params = {};
  if (needEdge) {
    if (maxEdge == null) return { error: 'Set maxEdge too' };
    if (!Number.isInteger(maxEdge) || maxEdge < 1) return { error: 'maxEdge must be a whole number of 1 or more' };
    params.maxEdge = maxEdge;
  }
  if (needScale) {
    if (scale == null) return { error: 'Set scale too' };
    if (!(scale > 0 && scale <= 1)) return { error: 'scale must be above 0 and at most 1' };
    params.scale = scale;
  }
  if (quality != null) {
    if (!Number.isInteger(quality) || quality < 1 || quality > 100) return { error: 'quality must be 1 to 100' };
    params.quality = quality;
  }
  return { params };
}

// Request body for POST /runs. `params` is omitted unless the admin overrode the preset
// (the backend treats an explicit {} as invalid).
export function runBody(op, rows, params) {
  const body = { op, subjects: rows.map((r) => ({ table: r.subject.table, key: r.subject.key, column: r.subject.column })) };
  if (params && Object.keys(params).length > 0) body.params = params;
  return body;
}
