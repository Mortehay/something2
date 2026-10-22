// Pure helpers for marking sprite-sheet frames to redraw (no DOM, no React).
export const DIRECTION_ORDER = ['s', 'se', 'e', 'ne', 'n'];
export const WESTERN = ['w', 'nw', 'sw'];
export const DOUBLED = ['e', 'ne', 'se'];

export function frameKey(action, direction, frame) {
  return `${action}/${direction}/${frame}`;
}

export function parseFrameKey(key) {
  const [action, direction, frame] = String(key).split('/');
  return { action, direction, frame: Number(frame) };
}

export function isMarkable(direction) {
  return !WESTERN.includes(direction);
}

export function toggleMark(marks, key) {
  const next = new Set(marks);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export function markRow(marks, action, direction, frames, on) {
  const next = new Set(marks);
  for (let i = 0; i < frames; i += 1) {
    const key = frameKey(action, direction, i);
    if (on) next.add(key);
    else next.delete(key);
  }
  return next;
}

const sortedUnique = (list) => [...new Set(list)].sort((a, b) => a - b);

export function contextFrames(frames, marked) {
  const set = new Set(marked);
  const out = new Set();
  for (const f of set) {
    for (const n of [f - 1, f + 1]) {
      if (n >= 0 && n < frames && !set.has(n)) out.add(n);
    }
  }
  return [...out].sort((a, b) => a - b);
}

export function rowSummary(frames, marked) {
  const list = sortedUnique(marked);
  if (!list.length) return null;
  if (list.length >= frames) {
    return { text: 'whole row · no neighbour context, drawn fresh from the concept', tone: 'warning' };
  }
  const ctx = contextFrames(frames, list);
  const names = (arr) => arr.map((f) => `f${f}`).join(', ');
  if (list.length === 1 && ctx.length === 1) {
    if (list[0] === 0) return { text: `f0 · context: f${ctx[0]} only (row start)`, tone: 'normal' };
    if (list[0] === frames - 1) return { text: `f${list[0]} · context: f${ctx[0]} only (row end)`, tone: 'normal' };
  }
  const lead = list.length >= 2 ? `${names(list)} redrawn in order` : names(list);
  return { text: `${lead} · context: ${names(ctx)}`, tone: 'normal' };
}

export function redrawPayload(marks, manifest) {
  const out = [];
  for (const row of manifest?.rows || []) {
    for (let i = 0; i < (row.frames || 0); i += 1) {
      const key = frameKey(row.action, row.direction, i);
      if (marks.has(key) && manifest.frames && key in manifest.frames) {
        out.push({ action: row.action, direction: row.direction, frame: i });
      }
    }
  }
  return out;
}

export function qualityByFrame(manifest) {
  const map = new Map();
  for (const q of manifest?.quality || []) {
    if (q.passed === false) map.set(frameKey(q.action, q.direction, q.frame), q);
  }
  return map;
}

// Each image is indexed with its own width; a pixel missing from either buffer counts as changed.
export function changedUnmarked(prev, next, manifest, redrawFrames) {
  const skip = new Set((redrawFrames || []).map((f) => (typeof f === 'string' ? f : frameKey(f.action, f.direction, f.frame))));
  const changed = [];
  for (const [key, rect] of Object.entries(manifest?.frames || {})) {
    if (skip.has(key)) continue;
    const [x, y, w, h] = rect;
    let differs = false;
    for (let row = y; row < y + h && !differs; row += 1) {
      for (let col = x; col < x + w; col += 1) {
        const pi = (row * prev.width + col) * 4;
        const ni = (row * next.width + col) * 4;
        for (let c = 0; c < 4; c += 1) {
          if (prev.data[pi + c] !== next.data[ni + c]) { differs = true; break; }
        }
        if (differs) break;
      }
    }
    if (differs) changed.push(key);
  }
  return changed;
}

export function shouldConfirmClose(marks) {
  return marks.size > 0;
}

// Pixel size of the sheet, from the furthest frame rect edges.
export function sheetSize(manifest) {
  let w = 0;
  let h = 0;
  for (const [x, y, fw, fh] of Object.values(manifest?.frames || {})) {
    w = Math.max(w, x + fw);
    h = Math.max(h, y + fh);
  }
  return { w, h };
}
