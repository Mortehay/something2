// Consistency checks for the World Map tab, plus the "what would this link
// destroy" calculation the confirm dialog depends on. All pure — vitest runs
// without a DOM here, so this is the layer that can actually be tested.
import { OPPOSITE, compassFromDelta } from './mapGraphLayout.js';

const key = (fromId, edge) => `${fromId}|${edge}`;

// A PORTAL is not a compass edge and has no direction-preserving opposite:
// setPortalLink's mirror is another PORTAL row with from/to (and their
// coordinates) swapped outright, NOT (to, OPPOSITE[edge]). OPPOSITE has no
// 'PORTAL' key, so an OPPOSITE lookup yields undefined and no portal mirror
// could ever be matched — which left every portal row emitting its own line,
// and two portals out of one world colliding on the `${fromId}|${edge}`
// element id the caller builds from these.
export const mirrorEdgeOf = (edge) => (edge === 'PORTAL' ? 'PORTAL' : OPPOSITE[edge]);

// setLink() writes a row AND its mirror, so the wire carries two rows per
// logical link. Fold them into one line each, and record whether the mirror
// was actually there — a row without one means one-way travel, which the API
// never creates but the schema permits.
export function collapseLinks(links) {
  const rows = Array.isArray(links) ? links : [];
  const done = new Set(); // row INDICES already folded into a line
  const out = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (done.has(i)) continue;
    const l = rows[i];
    done.add(i);
    // The mirror is a DIFFERENT row pointing back: (to, mirrorEdgeOf(edge)) ->
    // from. Matched by row identity rather than by a (from, edge) key, so a
    // duplicate key in malformed input cannot make an unrelated row disappear.
    const wantEdge = mirrorEdgeOf(l.edge);
    const mirrorIndex = rows.findIndex((r, j) => (
      !done.has(j)
      && r.from_world_id === l.to_world_id
      && r.edge === wantEdge
      && r.to_world_id === l.from_world_id
    ));
    if (mirrorIndex !== -1) done.add(mirrorIndex);
    out.push({
      fromId: l.from_world_id,
      edge: l.edge,
      toId: l.to_world_id,
      toEdge: wantEdge,
      mirrored: mirrorIndex !== -1,
    });
  }
  return out;
}

// The Cytoscape element id for a collapsed line. Compass edges are unique per
// (world, edge) by DB constraint, but a world may hold MANY portal rows, so a
// portal id has to carry its target too — otherwise two dungeon branches out
// of one hub both id themselves `<hub>|PORTAL`, cytoscape refuses the second
// ("Can not create second element with ID"), and one whole branch silently
// vanishes from the diagram.
export const edgeElementId = (fromId, edge, toId) => (
  edge === 'PORTAL' ? `${fromId}|PORTAL|${toId}` : `${fromId}|${edge}`
);

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
  // Drawn direction of each neighbour, per world. Registered from BOTH ends of
  // every line: which endpoint collapseLinks picked as `fromId` depends on the
  // order rows arrived in, so keying only on that would miss a world's own
  // duplicates whenever it happened to be the target both times.
  const noteDrawn = (worldId, direction, neighbourId) => {
    if (!drawnByWorld.has(worldId)) drawnByWorld.set(worldId, new Map());
    const seen = drawnByWorld.get(worldId);
    if (seen.has(direction)) {
      out.push({
        code: 'duplicate-direction',
        message: `${nameOf.get(worldId) || worldId} has two links drawn ${direction}; `
          + `move one of the neighbours apart.`,
        worldIds: [worldId, neighbourId, seen.get(direction)],
      });
      return;
    }
    seen.set(direction, neighbourId);
  };

  for (const link of collapsed) {
    if (!link.mirrored) {
      out.push({
        code: 'missing-mirror',
        message: `${nameOf.get(link.fromId) || link.fromId} links ${link.edge} to `
          + `${nameOf.get(link.toId) || link.toId}, but there is no return link — travel is one-way.`,
        worldIds: [link.fromId, link.toId],
      });
    }
    // Everything below this point is compass geometry: which way the line is
    // DRAWN versus which way its edge name says it should point. A portal has
    // no such direction to validate — it is deliberately off-grid (its two
    // ends are arbitrary tiles in two worlds, drawn wherever
    // placePortalClusters seated them), so measuring it against the compass
    // would invent a direction-mismatch on every portal, and its drawn
    // direction must not consume a compass slot in `drawnByWorld` either
    // (that would fabricate duplicate-direction warnings against real
    // compass links).
    if (link.edge === 'PORTAL') continue;
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
    noteDrawn(link.fromId, drawn, link.toId);
    noteDrawn(link.toId, compassFromDelta(a.x - b.x, a.y - b.y), link.fromId);
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
  // Only two lookups ever happen -- (fromId, edge) and (toId, OPPOSITE[edge])
  // -- and those two keys can never collide: edge !== OPPOSITE[edge] holds
  // for every N/E/S/W value, so a trailing dedup pass here has nothing to
  // ever remove. (An earlier version of this function had one; it was
  // unreachable and was removed along with its equally-unreachable test --
  // see the review notes on the final wave.)
  push(byKey.get(key(fromId, edge)), toId);
  push(byKey.get(key(toId, OPPOSITE[edge])), fromId);
  return out;
}
