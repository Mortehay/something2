import { seedPositions } from './mapGraphLayout.js';

// The payload -> cytoscape elements transform for the player's fog-of-war map
// (SOMET-263). Pure, and in its own module for the same reason mapGraphLayout.js
// is: vitest runs in a node environment in this project, so a component cannot
// be rendered in a test at all and every rule worth asserting has to live
// somewhere that can be imported.
//
// The fog is enforced by the API -- GET /api/player/world-map returns an
// unvisited neighbour as { id, from, edge } with no name -- so there is nothing
// to filter here. This module's job is to make sure it never invents a place to
// put one: a stub node's label is the literal '?', not a name it looked up.

// Fallback grid step for a node seedPositions could not place, in the same
// units as its own `cell`. Every node MUST get a position: the admin graph
// filters unplaced nodes out and then has to filter edges against the survivors
// because cy.add() throws on an edge with a missing endpoint. Guaranteeing a
// position removes that failure mode rather than catching it.
const CELL = 220;

export function toCytoscapeElements(payload) {
  const worlds = Array.isArray(payload && payload.worlds) ? payload.worlds : [];
  const links = Array.isArray(payload && payload.links) ? payload.links : [];
  const stubs = Array.isArray(payload && payload.unvisited) ? payload.unvisited : [];
  if (worlds.length === 0) return [];

  const currentWorldId = payload.currentWorldId;

  // seedPositions speaks the /api/world-graph row shape (from_world_id /
  // to_world_id / edge), so both the real links and the stub connections are
  // translated into it. Stubs are passed as coordinate-less worlds, which is
  // exactly the case its walk exists to handle: they get placed one cell along
  // the compass edge from the world they hang off.
  const layoutWorlds = [
    ...worlds,
    ...stubs.map((s) => ({ id: s.id })),
  ];
  const layoutLinks = [
    ...links.map((l) => ({ from_world_id: l.from, to_world_id: l.to, edge: l.edge })),
    ...stubs.map((s) => ({ from_world_id: s.from, to_world_id: s.id, edge: s.edge })),
  ];
  const positions = seedPositions(layoutWorlds, layoutLinks, { cell: CELL });

  let spare = 0;
  const positionOf = (id) => {
    const p = positions[id];
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return p;
    // Unreachable for anything the walk could seat; reached by a world with no
    // links at all and no stored coordinates. Laid out in a row below the
    // graph rather than dropped.
    spare += 1;
    return { x: spare * CELL, y: -CELL };
  };

  // `unvisited` and `current` are strings because cytoscape selectors match on
  // string data: `node[unvisited = "true"]` is the idiom, and a real boolean
  // would never match it. Same convention as the admin graph's `mirrored`.
  const nodes = [
    ...worlds.map((w) => ({
      data: {
        id: w.id,
        label: w.is_entry ? `★ ${w.name}` : w.name,
        unvisited: 'false',
        current: String(w.id === currentWorldId),
        // NO `travelable` (SOMET-293). This map used to carry a per-node travel
        // offer, backed by `allows_fast_travel` and the visit table; travel is
        // now the waypoint network, and the only way to move between worlds
        // without walking is to stand on a waypoint you have lit. The column
        // still exists and map authors still read it to decide where waypoints
        // belong -- it just stops being a thing a player can act on here.
        //
        // Deliberately not "travelable: 'false' everywhere": a field that is
        // always false is a field a later change can quietly make true again.
        //
        // SOMET-298: does this world hold a waypoint or a portal? Presence
        // only -- this surface is per-world granularity and stays that way, so
        // the badge says "there is one here", never where. A missing count is
        // read as none rather than throwing, so an older client against a newer
        // server degrades to an unbadged map instead of an error boundary.
        landmarks: String((Number(w.waypointCount) || 0) + (Number(w.portalCount) || 0) > 0),
      },
      position: positionOf(w.id),
    })),
    ...stubs.map((s) => ({
      data: {
        id: s.id,
        label: '?',
        unvisited: 'true',
        // A stub is somewhere the character has never been, so it can never be
        // where the character is. Set explicitly so every node carries the same
        // keys and the `data(current)` mappers have nothing to warn about.
        current: 'false',
        // NO `landmarks` (SOMET-298), deliberately absent rather than 'false'.
        // Same argument the retired `travelable` datum settled: a field that is
        // permanently false is a field a later change can quietly make true, and
        // here that would be a fog leak -- "this unexplored place has a
        // waypoint". `node[landmarks = "true"]` cannot match a missing datum, so
        // absence is also what makes the badge unreachable for a stub.
      },
      position: positionOf(s.id),
    })),
  ];

  // Edges filtered against the node ids actually emitted above, not against the
  // payload: cy.add() THROWS on an edge with a nonexistent source or target,
  // which unmounts the whole tab into the error boundary. This is the same
  // guard the admin graph carries, for the same reason.
  const ids = new Set(nodes.map((n) => n.data.id));
  const edges = [];
  const emitted = new Set();
  const pushEdge = (source, target, cls) => {
    if (!ids.has(source) || !ids.has(target)) return;
    const id = `${source}|${target}`;
    if (emitted.has(id)) return;
    emitted.add(id);
    edges.push({ data: { id, source, target, unvisited: cls } });
  };
  for (const l of links) pushEdge(l.from, l.to, 'false');
  for (const s of stubs) pushEdge(s.from, s.id, 'true');

  return [...nodes, ...edges];
}
