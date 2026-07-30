import { useEffect, useMemo, useRef, useState } from 'react';
import styled from 'styled-components';
import CytoscapeComponent from 'react-cytoscapejs';
import { useWorldGraph, useSaveGraphPosition } from './useMapGraph.js';
import { useBiomes } from './useBiomes.js';
import { seedPositions } from './mapGraphLayout.js';
import { collapseLinks, lintGraph } from './mapGraphLint.js';
import { biomeRingSvg } from './biomeRingSvg.js';

const AdminContainer = styled.div`
  padding: 2rem; color: #eee; max-width: 1400px; margin: 0 auto;
  height: 100%; overflow-y: auto; background-color: #1a1a2e;
`;
const Header = styled.div`display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;`;
const Layout = styled.div`display: flex; gap: 1rem; align-items: flex-start;`;
const CanvasCard = styled.div`
  flex: 1; height: 600px; background: #12121f;
  border: 1px solid #333; border-radius: 8px; overflow: hidden;
`;
const Side = styled.div`width: 260px; flex-shrink: 0;`;
const Card = styled.div`background: #23233f; border: 1px solid #333; border-radius: 8px; padding: 1rem; margin-bottom: 1rem;`;
const Warn = styled.div`color: #f59e0b; font-size: 0.85em; margin: 0.25rem 0;`;
const Dim = styled.div`color: #888; font-size: 0.9em; margin: 0.2rem 0;`;

const bounded = (w) => !!(w.width && w.height);

function MapGraphAdmin() {
  const { worlds, links, isLoadingGraph } = useWorldGraph();
  const { biomes } = useBiomes();
  const savePosition = useSaveGraphPosition();
  const cyRef = useRef(null);

  // The single source of truth for the position Cytoscape's `elements` prop
  // carries for each world. Populated once per world id (on first sight) and
  // again only on drag end -- NEVER wholesale-recomputed from a fresh
  // seedPositions() call once an id is already in here.
  //
  // react-cytoscapejs re-applies whatever `position` value is in `elements`
  // on every prop diff (see node_modules/react-cytoscapejs/src/patch.js:
  // patchElement() calls cyEle.json({position}) whenever the value differs
  // from the previous render's value). seedPositions() is a pure function of
  // (worlds, links) -- its BFS walk can reassign an unpositioned node's cell
  // whenever the topology changes (e.g. another admin adds/removes a link
  // while this admin is mid-drag on a node that has no stored graph_x/y
  // yet). If `elements` fed that freshly-recomputed value straight through
  // every render, a concurrent topology change could yank a node the admin
  // is actively dragging out from under the cursor. Freezing each id's
  // position after it is first seeded, and only ever updating it from an
  // explicit drag-end read, removes that feedback path entirely: dragging
  // sets this map, which is the only thing `elements` reads, so there is
  // nothing left to fight over.
  const [positions, setPositions] = useState({});

  const linkable = useMemo(() => worlds.filter(bounded), [worlds]);
  const unbounded = useMemo(() => worlds.filter((w) => !bounded(w)), [worlds]);

  // Seed a position for any linkable world not yet in `positions` (first
  // load, or a world that just became bounded). Ids already present are
  // left untouched.
  useEffect(() => {
    setPositions((prev) => {
      const missing = linkable.filter((w) => !prev[w.id]);
      if (missing.length === 0) return prev;
      const seeded = seedPositions(linkable, links);
      const next = { ...prev };
      for (const w of missing) {
        if (seeded[w.id]) next[w.id] = seeded[w.id];
      }
      return next;
    });
  }, [linkable, links]);

  const colourOf = useMemo(() => {
    const map = new Map((biomes || []).map((b) => [b.name, b.color]));
    return (names) => (names || []).map((n) => map.get(n)).filter(Boolean);
  }, [biomes]);

  const warnings = useMemo(
    () => lintGraph({ worlds: linkable, links, positions }),
    [linkable, links, positions],
  );

  const elements = useMemo(() => {
    const nodes = linkable
      .filter((w) => positions[w.id])
      .map((w) => ({
        data: {
          id: w.id,
          label: w.is_entry ? `★ ${w.name}` : w.name,
          ring: biomeRingSvg(colourOf(w.biomes)),
        },
        position: positions[w.id],
      }));
    const edges = collapseLinks(links)
      .filter((l) => positions[l.fromId] && positions[l.toId])
      .map((l) => ({
        data: {
          id: `${l.fromId}|${l.edge}`,
          source: l.fromId,
          target: l.toId,
          label: `${l.edge}↔${l.toEdge}`,
          mirrored: String(l.mirrored),
        },
      }));
    return [...nodes, ...edges];
  }, [linkable, links, positions, colourOf]);

  const stylesheet = useMemo(() => ([
    {
      selector: 'node',
      style: {
        'background-color': '#23233f',
        'background-image': 'data(ring)',
        'background-fit': 'cover',
        'border-width': 1,
        'border-color': '#444',
        width: 64, height: 64,
        label: 'data(label)',
        color: '#eee',
        'font-size': 11,
        'text-valign': 'bottom',
        'text-margin-y': 6,
      },
    },
    {
      selector: 'edge',
      style: {
        'curve-style': 'straight',
        'line-color': '#4a9eff',
        width: 2,
        label: 'data(label)',
        color: '#9bb',
        'font-size': 10,
        'text-background-color': '#12121f',
        'text-background-opacity': 0.8,
      },
    },
    { selector: 'edge[mirrored = "false"]', style: { 'line-color': '#f59e0b', 'line-style': 'dashed' } },
    { selector: ':selected', style: { 'border-color': '#facc15', 'border-width': 3, 'line-color': '#facc15' } },
  ]), []);

  // Persist a node's position when the admin finishes dragging it. Also
  // freezes it into `positions` immediately so the very next render feeds
  // Cytoscape the exact value it already has -- no round trip to the server
  // needed before the picture agrees with itself.
  //
  // Depends on `savePosition.mutate` rather than the whole mutation object:
  // TanStack Query returns a new mutation object on every state transition
  // (idle -> pending -> success), and `mutate` itself is the stable part of
  // it. Depending on the object would re-subscribe this listener on every
  // drag's own pending/success cycle for no reason.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return undefined;
    const onFree = (evt) => {
      const node = evt.target;
      const { x, y } = node.position();
      setPositions((prev) => ({ ...prev, [node.id()]: { x, y } }));
      savePosition.mutate({ id: node.id(), x, y });
    };
    cy.on('free', 'node', onFree);
    return () => { cy.off('free', 'node', onFree); };
  }, [savePosition.mutate]);

  if (isLoadingGraph) return <AdminContainer>Loading world graph…</AdminContainer>;

  return (
    <AdminContainer>
      <Header><h2>World Map</h2></Header>
      <Layout>
        <CanvasCard>
          <CytoscapeComponent
            elements={elements}
            stylesheet={stylesheet}
            layout={{ name: 'preset' }}
            style={{ width: '100%', height: '100%' }}
            cy={(cy) => { cyRef.current = cy; }}
          />
        </CanvasCard>
        <Side>
          <Card>
            <strong style={{ color: '#aaa' }}>Consistency</strong>
            {warnings.length === 0 && <Dim>No problems found.</Dim>}
            {warnings.map((w, i) => <Warn key={`${w.code}-${i}`}>{w.message}</Warn>)}
          </Card>
          <Card>
            <strong style={{ color: '#aaa' }}>Not linkable ({unbounded.length})</strong>
            <Dim>These worlds have no width and height, so they cannot hold links. Set bounds in the Maps tab.</Dim>
            {unbounded.map((w) => <Dim key={w.id}>○ {w.name}</Dim>)}
          </Card>
        </Side>
      </Layout>
    </AdminContainer>
  );
}

export default MapGraphAdmin;
