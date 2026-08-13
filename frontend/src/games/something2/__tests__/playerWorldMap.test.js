import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toCytoscapeElements } from '../playerWorldMap.js';

// Cytoscape cannot be mounted here (vitest runs in a node environment), so the
// payload -> elements transform lives in its own module, exactly as
// mapGraphLayout.js does for the admin graph.
const PAYLOAD = {
  worlds: [
    // `a` is a travel target the character is not standing in; `b` is flagged
    // AND current, which is the case the transform has to exclude.
    { id: 'a', name: 'Overworld', graph_x: 0, graph_y: 0, is_entry: true, level_min: 1, level_max: 3, allows_fast_travel: true },
    { id: 'b', name: 'Deep Forest', graph_x: 220, graph_y: 0, is_entry: false, level_min: 3, level_max: 6, allows_fast_travel: true },
  ],
  links: [{ from: 'a', to: 'b', edge: 'E' }],
  unvisited: [{ id: 'c', from: 'b', edge: 'E' }],
  currentWorldId: 'b',
};

describe('toCytoscapeElements', () => {
  const els = toCytoscapeElements(PAYLOAD);
  const nodes = els.filter((e) => !e.data.source);
  const edges = els.filter((e) => e.data.source);

  it('renders a node per visited world plus one per unvisited stub', () => {
    expect(nodes.map((n) => n.data.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('labels visited worlds with their name', () => {
    expect(nodes.find((n) => n.data.id === 'a').data.label).toBe('★ Overworld');
    expect(nodes.find((n) => n.data.id === 'b').data.label).toBe('Deep Forest');
  });

  it('never labels an unvisited stub with a name', () => {
    const stub = nodes.find((n) => n.data.id === 'c');
    expect(stub.data.unvisited).toBe('true');
    expect(stub.data.label).toBe('?');
  });

  it('carries no field on a stub beyond what the map needs to draw it', () => {
    // The endpoint withholds the name; this asserts the transform does not
    // invent a place to put one later. Whatever `data` holds must be drawable
    // from the stub payload alone.
    const stub = nodes.find((n) => n.data.id === 'c');
    expect(Object.keys(stub.data).sort()).toEqual(['current', 'id', 'label', 'unvisited']);
  });

  it('offers travel on no node, whatever the payload says (SOMET-293)', () => {
    // THE RETIREMENT, on the transform side. `a` is flagged and visited and is
    // not where the character is standing -- the exact shape that used to come
    // out `travelable: 'true'`, and the shape the acceptance criterion names as
    // now refused by the server. It must not carry the datum at all.
    //
    // Absent rather than always-'false': a field that is permanently false is a
    // field a later change can quietly make true again, and the stylesheet rule
    // it drove is gone too, so a stray 'true' would be silent rather than wrong.
    for (const n of nodes) {
      expect(n.data, `node ${n.data.id}`).not.toHaveProperty('travelable');
    }
    // Including when the flag arrives on a stub, which the endpoint does not
    // send today -- the transform must not start reading it either.
    const els2 = toCytoscapeElements({
      ...PAYLOAD,
      worlds: [{ ...PAYLOAD.worlds[0], allows_fast_travel: true }, PAYLOAD.worlds[1]],
      unvisited: [{ id: 'c', from: 'b', edge: 'E', allows_fast_travel: true }],
    });
    for (const e of els2) expect(e.data).not.toHaveProperty('travelable');
  });

  it('marks the current world', () => {
    expect(nodes.find((n) => n.data.id === 'b').data.current).toBe('true');
    expect(nodes.find((n) => n.data.id === 'a').data.current).toBe('false');
  });

  it('gives every node a position, so no node is ever dropped', () => {
    // The admin graph filters nodes to those with a position and then filters
    // edges to the surviving node ids, because cy.add() THROWS on an edge whose
    // endpoint is missing. Guaranteeing a position for every node removes the
    // failure mode instead of catching it.
    for (const n of nodes) {
      expect(Number.isFinite(n.position.x), `${n.data.id} has no x`).toBe(true);
      expect(Number.isFinite(n.position.y), `${n.data.id} has no y`).toBe(true);
    }
  });

  it('honours stored graph coordinates for visited worlds', () => {
    expect(nodes.find((n) => n.data.id === 'a').position).toEqual({ x: 0, y: 0 });
    expect(nodes.find((n) => n.data.id === 'b').position).toEqual({ x: 220, y: 0 });
  });

  it('draws an edge to the unvisited stub so the player knows a door exists', () => {
    expect(edges.some((e) => e.data.source === 'b' && e.data.target === 'c')).toBe(true);
  });

  it('emits no edge whose endpoints are not both emitted as nodes', () => {
    const ids = new Set(nodes.map((n) => n.data.id));
    for (const e of edges) {
      expect(ids.has(e.data.source), `dangling source ${e.data.source}`).toBe(true);
      expect(ids.has(e.data.target), `dangling target ${e.data.target}`).toBe(true);
    }
  });

  it('gives every element a distinct id', () => {
    const ids = els.map((e) => e.data.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('produces no elements at all for an empty payload', () => {
    expect(toCytoscapeElements({ worlds: [], links: [], unvisited: [], currentWorldId: null })).toEqual([]);
  });

  it('tolerates a missing payload while the query is in flight', () => {
    expect(toCytoscapeElements(undefined)).toEqual([]);
  });

  it('tolerates a payload whose arrays are missing entirely', () => {
    // A 500 body, or an older server. Reading `.map` off undefined here would
    // unmount the whole tab into the error boundary.
    expect(toCytoscapeElements({})).toEqual([]);
  });

  it('drops a link pointing at a world not in the payload', () => {
    // cy.add() throws on an edge with a nonexistent endpoint, which would take
    // the tab down rather than degrade.
    const els2 = toCytoscapeElements({
      ...PAYLOAD, links: [...PAYLOAD.links, { from: 'a', to: 'ghost', edge: 'N' }],
    });
    expect(els2.some((e) => e.data.target === 'ghost')).toBe(false);
  });
});

describe('the player map is read-only by construction', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, '../PlayerWorldMap.jsx'), 'utf8');

  // Absence assertions, not the presence of a readOnly flag: a flag can be true
  // and still have an unguarded branch behind it.
  it('imports no edgehandles', () => {
    expect(source).not.toMatch(/edgehandles/);
  });

  it('calls no mutation hook', () => {
    expect(source).not.toMatch(/useSetLink|useClearLink|useSaveGraphPosition/);
    expect(source).not.toMatch(/useCreateWorld|useDeleteWorld|useUpdateWorld/);
    expect(source).not.toMatch(/useMutation/);
  });

  it('persists no dragged position', () => {
    // The admin graph's drag-end listener is what writes graph_x/graph_y. The
    // player map must not have one -- a player dragging a node must not
    // relayout the world graph for everyone.
    expect(source).not.toMatch(/dragfree/);
    // The plan specified `autoungrabify: true`, an object-literal shape.
    // react-cytoscapejs takes it as a PROP (it is in patch.js's patched-key
    // list), so the object form would have been dead config that read as a
    // guard. Asserted in the form that actually reaches cytoscape.
    expect(source).toMatch(/autoungrabify=\{true\}/);
  });

  it('has no way to act on a node at all (SOMET-293)', () => {
    // THE RETIREMENT. This component briefly carried click-to-travel; travel is
    // now the waypoint network and the `fast-travel` leg that authorized the
    // old click is deleted from services/joinPolicy.js. Left here, the handler
    // would still fire and the join would be refused -- an inert click with no
    // explanation, which the map's own legend comment already calls out as
    // reading like a broken feature.
    //
    // Asserted as an ABSENCE over the source, which is the one thing a
    // behavioural test cannot do here: vitest runs in a node environment, so
    // cytoscape cannot be mounted and "no handler fires" has nothing to fire
    // against. The same reasoning the editing-capability absences below are
    // written under.
    expect(source).not.toMatch(/cy\.on\(/);
    expect(source).not.toMatch(/travelable/);
    // Cytoscape's own graph-mutation API. Spelled out rather than as a loose
    // `.json(` -- that also matched `res.json()` in the query function, which
    // is how a "no mutation" assertion can fail on a fetch.
    expect(source).not.toMatch(/cy\.add\(|cy\.remove\(|cy\.json\(/);
  });

  it('cannot enter a world by any route', () => {
    // Both spellings: through GameShell (the old click-to-travel path) and by
    // opening a socket of its own (the two-loader shape that has shipped inert
    // features in this project before). Neither belongs on a map that no longer
    // travels.
    expect(source).not.toMatch(/enterWorld/);
    expect(source).not.toMatch(/useNavigate|navigate\(/);
    expect(source).not.toMatch(/WorldAuthorityClient|initChunked|new WebSocket/);
  });

  it('GameShell.enterWorld still guards its own entry paths', () => {
    // enterWorld survives the retirement -- auto-join, the admin picker and the
    // server-driven `transition` (which is how a waypoint trip lands) all go
    // through it. Its guards are asserted here rather than left to the file that
    // no longer calls it, because a bug in them lives in a DIFFERENT file from
    // its symptom.
    const shell = fs.readFileSync(path.join(here, '../GameShell.jsx'), 'utf8');
    const body = shell.slice(
      shell.indexOf('const enterWorld'), shell.indexOf('handleEnterRef.current = enterWorld'));
    expect(body).toMatch(/setIsPlaying\(true\);/);
    // Entering a world -- however it happened -- disarms auto-join. Without
    // this, a later re-evaluation where isPlaying read false sent the character
    // back to the stale activeCharacter.lastWorldId, i.e. the world it had just
    // travelled away from. Observed live before it was fixed, and a waypoint
    // trip is exactly the same shape of move.
    expect(body).toMatch(/autoJoinedRef\.current = true;/);
    expect(body).toMatch(/toast\.error\(err\.message\);\s*\n\s*return false;/);
    // The early bail-outs too: no game instance, or no character chosen.
    expect(body).toMatch(/if \(!worldId \|\| !gameRef\.current\) return false;/);
    expect(body).toMatch(/if \(!activeCharacter\) return false;/);
  });

  it('reads the fog-of-war endpoint, not the admin world graph', () => {
    // /api/world-graph returns every world unconditionally. Reading it here
    // would render a complete map and defeat the entire feature while every
    // assertion above still passed.
    expect(source).not.toMatch(/world-graph|useWorldGraph/);
    expect(source).toMatch(/player\/world-map/);
  });
});
