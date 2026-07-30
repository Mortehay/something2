import { useEffect, useMemo, useState } from 'react';
import styled from 'styled-components';
import CytoscapeComponent from 'react-cytoscapejs';
import cytoscape from 'cytoscape';
import edgehandles from 'cytoscape-edgehandles';
import { useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { useWorldGraph, useSaveGraphPosition } from './useMapGraph.js';
import { useBiomes } from './useBiomes.js';
import { useSetLink, useClearLink } from './useMapsAdmin.js';
import { seedPositions, compassFromDelta, OPPOSITE } from './mapGraphLayout.js';
import { collapseLinks, lintGraph, linksReplacedBy } from './mapGraphLint.js';
import { planLinkChange } from './mapGraphActions.js';
import { biomeRingSvg } from './biomeRingSvg.js';

// Registered once at module scope, not inside the component: `cytoscape.use`
// mutates the shared cytoscape module-level registry, so re-registering on
// every render would be redundant at best. Cytoscape itself no-ops a repeat
// registration, but there's no reason to call it more than once.
cytoscape.use(edgehandles);

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
const Row = styled.div`display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; margin: 0.4rem 0;`;
const Button = styled.button`
  background: ${(p) => p.$bg || '#4a9eff'}; color: white; border: none; border-radius: 6px;
  padding: 0.5rem 1rem; font-weight: bold; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
  &:disabled { opacity: 0.5; cursor: default; }
`;

const bounded = (w) => !!(w.width && w.height);

function MapGraphAdmin() {
  const { worlds, links, isLoadingGraph } = useWorldGraph();
  const { biomes } = useBiomes();
  const savePosition = useSaveGraphPosition();
  const setLink = useSetLink();
  const clearLink = useClearLink();
  const qc = useQueryClient();
  // Held in state, not a ref: the drag-end listener effect below needs a real
  // dependency to re-run once the instance exists. `cyRef.current` would
  // never trigger a re-run of an effect on its own, and since that effect's
  // other dependency (`savePosition.mutate`) is permanently stable, an effect
  // gated on a ref alone would only ever fire once, on the render where React
  // first evaluates it -- which is BEFORE `CytoscapeComponent` has mounted on
  // a first (uncached) visit, since `isLoadingGraph` is still true then. That
  // combination meant the drag-end listener never attached on a first visit
  // at all (see the fix report for the walk-through).
  const [cy, setCy] = useState(null);

  const linkable = useMemo(() => worlds.filter(bounded), [worlds]);
  const unbounded = useMemo(() => worlds.filter((w) => !bounded(w)), [worlds]);

  // Drag-end positions only. Everything else is derived fresh from
  // seedPositions() every render, so `positions` can never carry a world id
  // that `linkable` no longer has (e.g. a world whose bounds were cleared
  // from another session after this tab was already mounted). An id that
  // outlived its world would emit an edge whose endpoint node got filtered
  // out of `elements` -- and cy.add() THROWS on an edge with a nonexistent
  // source/target, which would unmount this whole tab into the error
  // boundary. `dragged` entries win over the fresh seed (spread last) so a
  // hand-placed or dragged position is never silently reseeded out from
  // under the admin.
  const [dragged, setDragged] = useState({});
  const positions = useMemo(() => (
    linkable.every((w) => dragged[w.id])
      ? dragged
      : { ...seedPositions(linkable, links), ...dragged }
  ), [linkable, links, dragged]);

  // A drag-to-connect gesture never writes anything by itself -- it only
  // proposes { fromId, edge, toId } here. The confirm panel is what calls
  // commitPending(). `selectedEdge` is the delete-side counterpart: which
  // drawn edge (by its Cytoscape id, `${fromId}|${edge}`) is currently
  // selected on the canvas.
  const [pending, setPending] = useState(null); // { fromId, toId, edge }
  const [selectedEdge, setSelectedEdge] = useState(null); // { fromId, edge, toId }
  const [busy, setBusy] = useState(false);

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
    // Filtered against the node ids actually emitted above, not against
    // `positions` directly: with a synchronously-derived `positions` the two
    // sets agree in steady state, but deriving edges from the SAME set the
    // nodes were built from removes any chance of the two ever drifting
    // apart, which is exactly the drift that made cy.add() throw (Finding 3).
    const ids = new Set(nodes.map((n) => n.data.id));
    const edges = collapseLinks(links)
      .filter((l) => ids.has(l.fromId) && ids.has(l.toId))
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
  // freezes it into `dragged` immediately so the very next render feeds
  // Cytoscape the exact value it already has -- no round trip to the server
  // needed before the picture agrees with itself.
  //
  // Depends on `cy` (state, so this effect actually re-runs once the
  // instance shows up -- see the comment on `useState(null)` above) and on
  // `savePosition.mutate` rather than the whole mutation object: TanStack
  // Query returns a new mutation object on every state transition (idle ->
  // pending -> success), and `mutate` itself is the stable part of it.
  // Depending on the object would re-subscribe this listener on every drag's
  // own pending/success cycle for no reason.
  //
  // Listens for `dragfree`, not `free`: Cytoscape emits `free` on every
  // mouseup after a grab, including a plain click with no movement, but
  // `dragfree` only fires `if (r.dragData.didDrag)`. Using `free` would PUT a
  // graph-position (and promote an auto-seeded cell to a stored one,
  // silencing its "unpositioned" lint warning and taking that cell out of
  // circulation for seedPositions()'s BFS walk) on every click, never mind a
  // drag.
  //
  // Edgehandles, edge-select and edge-unselect are bound in this SAME effect
  // (same reasoning as the comment on `useState(null)` above: it needs to
  // re-run once `cy` actually exists). `cy.edgehandles()` is started here too
  // rather than once at mount, since it needs the same live `cy` instance;
  // `eh.destroy()` undoes it in the cleanup so a re-run (or unmount) never
  // stacks a second edgehandles instance on the same core.
  //
  // ehcomplete's 4th argument is technically a Cytoscape *collection*
  // (`cy.collection().merge(...)` internally), not a single edge element --
  // but `.remove()` is a Collection method that removes every element in it,
  // so calling it here is correct regardless: this graph is not compound, so
  // the collection always holds exactly the one preview edge edgehandles just
  // added. It is removed immediately because this UI confirms before it
  // writes anything -- the pending proposal, not the edge itself, is what
  // gets shown.
  useEffect(() => {
    if (!cy) return undefined;
    const onDragFree = (evt) => {
      const node = evt.target;
      const { x, y } = node.position();
      setDragged((prev) => ({ ...prev, [node.id()]: { x, y } }));
      savePosition.mutate({ id: node.id(), x, y });
    };
    const eh = cy.edgehandles({ snap: true });
    const onComplete = (evt, source, target, addedEdge) => {
      addedEdge.remove();
      const a = source.position();
      const b = target.position();
      setPending({ fromId: source.id(), toId: target.id(), edge: compassFromDelta(b.x - a.x, b.y - a.y) });
    };
    const onSelect = (evt) => {
      const [fromId, edge] = evt.target.id().split('|');
      setSelectedEdge({ fromId, edge, toId: evt.target.data('target') });
    };
    const onUnselect = () => setSelectedEdge(null);
    cy.on('dragfree', 'node', onDragFree);
    cy.on('ehcomplete', onComplete);
    cy.on('select', 'edge', onSelect);
    cy.on('unselect', 'edge', onUnselect);
    return () => {
      cy.off('dragfree', 'node', onDragFree);
      cy.off('ehcomplete', onComplete);
      cy.off('select', 'edge', onSelect);
      cy.off('unselect', 'edge', onUnselect);
      eh.destroy();
    };
  }, [cy, savePosition.mutate]);

  const nameOf = (id) => (worlds.find((w) => w.id === id) || {}).name || id;
  const replaced = pending
    ? linksReplacedBy({ links, fromId: pending.fromId, edge: pending.edge, toId: pending.toId })
    : [];

  // Runs the plan in order and reports a partial failure honestly: a create
  // that fails after the clears already landed leaves those worlds
  // UNLINKED, not still linked to their old neighbours, so a plain "it
  // failed, nothing changed" toast would be a lie. `pending` is only cleared
  // on full success, so the confirm panel stays open (re-deriving `replaced`
  // from whatever `links` now actually is) rather than silently vanishing.
  const commitPending = async () => {
    if (!pending) return;
    const plan = planLinkChange({ links, ...pending });
    setBusy(true);
    try {
      for (const c of plan.clears) {
        await clearLink.mutateAsync({ id: c.fromId, edge: c.edge });
      }
      await setLink.mutateAsync({ id: plan.create.fromId, edge: plan.create.edge, to_world_id: plan.create.toId });
      setPending(null);
    } catch {
      // The hooks already toast the underlying failure. Say what state we
      // are actually in.
      toast.error('Link change did not complete — the diagram has been refreshed to show the real state.');
    } finally {
      setBusy(false);
      qc.invalidateQueries({ queryKey: ['worldGraph'] });
    }
  };

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
            cy={setCy}
          />
        </CanvasCard>
        <Side>
          {pending && (
            <Card>
              <strong style={{ color: '#aaa' }}>New link</strong>
              <Row>
                {nameOf(pending.fromId)} edge{' '}
                <select value={pending.edge} onChange={(e) => setPending({ ...pending, edge: e.target.value })}>
                  {['N', 'E', 'S', 'W'].map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
                {' → '}{nameOf(pending.toId)} gets {OPPOSITE[pending.edge]}
              </Row>
              <Warn>
                Creating this link rebuilds terrain for both worlds, the same as any other terrain
                change — a player currently in either one will be evicted or warned.
              </Warn>
              {replaced.length > 0 && (
                <Warn>
                  This replaces {replaced.length} existing link{replaced.length > 1 ? 's' : ''}:{' '}
                  {replaced.map((r) => `${nameOf(r.from_world_id)} ${r.edge} → ${nameOf(r.to_world_id)}`).join('; ')}
                </Warn>
              )}
              <Row>
                <Button onClick={commitPending} disabled={busy}>
                  {replaced.length > 0 ? 'Replace and link' : 'Create link'}
                </Button>
                <Button $bg="#555" onClick={() => setPending(null)}>Cancel</Button>
              </Row>
            </Card>
          )}
          {selectedEdge && (
            <Card>
              <strong style={{ color: '#aaa' }}>Selected link</strong>
              <Row>
                {nameOf(selectedEdge.fromId)} {selectedEdge.edge} → {nameOf(selectedEdge.toId)}
              </Row>
              <Warn>Removing this clears BOTH directions, and rebuilds terrain for both worlds.</Warn>
              <Row>
                <Button
                  $bg="#ef4444"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await clearLink.mutateAsync({ id: selectedEdge.fromId, edge: selectedEdge.edge });
                      setSelectedEdge(null);
                    } finally {
                      setBusy(false);
                      qc.invalidateQueries({ queryKey: ['worldGraph'] });
                    }
                  }}
                >
                  Remove link
                </Button>
              </Row>
            </Card>
          )}
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
