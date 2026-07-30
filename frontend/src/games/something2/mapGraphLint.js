// Consistency checks for the World Map tab, plus the "what would this link
// destroy" calculation the confirm dialog depends on. All pure — vitest runs
// without a DOM here, so this is the layer that can actually be tested.
import { OPPOSITE, compassFromDelta } from './mapGraphLayout.js';

const key = (fromId, edge) => `${fromId}|${edge}`;

// setLink() writes a row AND its mirror, so the wire carries two rows per
// logical link. Fold them into one line each, and record whether the mirror
// was actually there — a row without one means one-way travel, which the API
// never creates but the schema permits.
export function collapseLinks(links) {
  const rows = Array.isArray(links) ? links : [];
  const byKey = new Map(rows.map((l) => [key(l.from_world_id, l.edge), l]));
  const done = new Set();
  const out = [];
  for (const l of rows) {
    const k = key(l.from_world_id, l.edge);
    if (done.has(k)) continue;
    const mirrorKey = key(l.to_world_id, OPPOSITE[l.edge]);
    const mirror = byKey.get(mirrorKey);
    const mirrored = Boolean(mirror && mirror.to_world_id === l.from_world_id);
    done.add(k);
    if (mirrored) done.add(mirrorKey);
    out.push({
      fromId: l.from_world_id,
      edge: l.edge,
      toId: l.to_world_id,
      toEdge: OPPOSITE[l.edge],
      mirrored,
    });
  }
  return out;
}

// Warnings, never errors. The live topology is already spatially
// contradictory (one world linked to another on all four edges at once); that
// is legal, reachable from the existing Maps tab, and must stay editable.
export function lintGraph({ worlds, links, positions }) {
  const list = Array.isArray(worlds) ? worlds : [];
  const pos = positions || {};
  const nameOf = new Map(list.map((w) => [w.id, w.name || w.id]));
  const out = [];

  const collapsed = collapseLinks(links);
  const drawnByWorld = new Map();

  for (const link of collapsed) {
    if (!link.mirrored) {
      out.push({
        code: 'missing-mirror',
        message: `${nameOf.get(link.fromId) || link.fromId} links ${link.edge} to `
          + `${nameOf.get(link.toId) || link.toId}, but there is no return link — travel is one-way.`,
        worldIds: [link.fromId, link.toId],
      });
    }
    const a = pos[link.fromId];
    const b = pos[link.toId];
    if (!a || !b) continue;
    const drawn = compassFromDelta(b.x - a.x, b.y - a.y);
    if (drawn !== link.edge) {
      out.push({
        code: 'direction-mismatch',
        message: `${nameOf.get(link.fromId) || link.fromId} links ${link.edge} to `
          + `${nameOf.get(link.toId) || link.toId}, but it is drawn ${drawn}. `
          + `Move a node, or change the link's edge.`,
        worldIds: [link.fromId, link.toId],
      });
    }
    if (!drawnByWorld.has(link.fromId)) drawnByWorld.set(link.fromId, new Map());
    const seen = drawnByWorld.get(link.fromId);
    if (seen.has(drawn)) {
      out.push({
        code: 'duplicate-direction',
        message: `${nameOf.get(link.fromId) || link.fromId} has two links drawn ${drawn}; `
          + `move one of the neighbours apart.`,
        worldIds: [link.fromId, link.toId, seen.get(drawn)],
      });
    } else {
      seen.set(drawn, link.toId);
    }
  }

  for (const w of list) {
    if (!Number.isFinite(w.graph_x) || !Number.isFinite(w.graph_y)) {
      out.push({
        code: 'unpositioned',
        message: `${w.name || w.id} has no saved position — it was placed automatically. `
          + `Drag it to keep this layout.`,
        worldIds: [w.id],
      });
    }
  }
  return out;
}

// Which existing rows creating (fromId, edge, toId) would destroy.
//
// setLink upserts on (from_world_id, edge) TWICE: once for the new link and
// once for its mirror. So it silently displaces whatever occupied the source's
// `edge` slot AND whatever occupied the target's opposite slot — and it leaves
// each displaced link's OWN mirror behind, dangling. The caller is expected to
// clear these explicitly before creating, rather than letting the upsert
// half-do it (see the plan's Task 8).
export function linksReplacedBy({ links, fromId, edge, toId }) {
  const rows = Array.isArray(links) ? links : [];
  const byKey = new Map(rows.map((l) => [key(l.from_world_id, l.edge), l]));
  const out = [];
  const push = (row, wantedTarget) => {
    if (row && row.to_world_id !== wantedTarget) out.push(row);
  };
  push(byKey.get(key(fromId, edge)), toId);
  push(byKey.get(key(toId, OPPOSITE[edge])), fromId);
  const seen = new Set();
  return out.filter((l) => {
    const k = key(l.from_world_id, l.edge);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
