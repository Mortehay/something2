// The Skill Tree admin tab's rules (SOMET-571). Pure, like artSelection.js:
// the component renders these and decides nothing itself.
//
// WHAT THIS TAB IS FOR. catalog_art holds icons for the 300 class skills and
// the 128 passive labels, and nothing in the game reads them yet -- the skills
// panel still draws the emoji, the passive tree draws circles. The Art console
// shows every icon in a flat table, which cannot answer the question that
// decides whether an icon is any good: does it read at 48 px in the skills
// panel, and does it sit inside a node of its sector on the tree? This tab
// draws the art IN PLACE and links back to the console for the fixing.

import { subjectId } from './artSelection.js';

// --- Art lookup --------------------------------------------------------------

// Keyed by kind PLUS key, the same namespace catalog_art uses for its primary
// key. "Focus" is both a passive label and a plausible skill id; a key-only
// index would give one of them the other's icon.
export function indexArt(subjects) {
  return new Map((subjects || []).map((s) => [subjectId(s), s]));
}

// The subject if it has a drawable image, else null. `has_art` alone is not
// enough: a row flagged has_art with a blank image path would render an empty
// <image> where the dashed "missing" ring should be.
export function artFor(index, kind, key) {
  const s = index.get(subjectId({ kind, key }));
  if (!s || !s.has_art || !s.image) return null;
  return s;
}

export function artCoverage(index, kind, keys) {
  let withArt = 0;
  for (const key of keys) if (artFor(index, kind, key)) withArt += 1;
  return { total: keys.length, withArt, missing: keys.length - withArt };
}

export function onlyMissing(index, kind, items, keyOf) {
  return items.filter((item) => !artFor(index, kind, keyOf(item)));
}

// Art is per LABEL, not per node (catalogSubjects.js: 128 labels across 1852
// nodes), so artCoverage is counted over the distinct labels.
export function distinctLabels(nodes) {
  const seen = new Set();
  const out = [];
  for (const n of nodes || []) {
    const label = n && n.label;
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}

// --- SVG viewBox geometry ----------------------------------------------------

// A finite box even for no nodes: SVG, like Canvas 2D, silently draws nothing
// for a non-finite viewBox (SOMET-488), and the tree query is empty while it
// loads.
const EMPTY_BOUNDS = Object.freeze({ x: -500, y: -500, w: 1000, h: 1000 });

export function treeBounds(nodes, pad = 0) {
  if (!nodes || nodes.length === 0) return { ...EMPTY_BOUNDS };
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.y > maxY) maxY = n.y;
  }
  return { x: minX - pad, y: minY - pad, w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 };
}

// The box may shrink to 1/50th of, or grow to 20x, the tree's own extent. The
// clamp is on the RESULTING width rather than on an accumulated zoom level, so
// it holds no matter how the box got here.
const MIN_W = 40;
const MAX_W = 200000;

// Scale the box by 1/factor about a world-space focus point, so the point
// under the cursor stays under the cursor.
export function zoomViewBox(box, factor, fx, fy) {
  const w = Math.min(MAX_W, Math.max(MIN_W, box.w / factor));
  const scale = w / box.w;
  const h = box.h * scale;
  return {
    x: fx - (fx - box.x) * scale,
    y: fy - (fy - box.y) * scale,
    w,
    h,
  };
}

// Drag by (dx, dy) screen pixels; `unitsPerPx` converts to world units. The
// box moves opposite to the drag so the content follows the cursor.
export function panViewBox(box, dx, dy, unitsPerPx) {
  return { ...box, x: box.x - dx * unitsPerPx, y: box.y - dy * unitsPerPx };
}

// --- Navigation --------------------------------------------------------------

// The console defaults to art=missing (the resume filter). A link to a subject
// that HAS art must widen that, or the click lands on an empty table.
export function artConsoleLink(kind, key) {
  const qs = new URLSearchParams({ kind, art: 'all', q: key });
  return `/game/art?${qs.toString()}`;
}
