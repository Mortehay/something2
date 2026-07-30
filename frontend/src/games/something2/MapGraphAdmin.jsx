import { useEffect, useMemo, useRef, useState } from 'react';
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

  // A signature of the SEEDED layout only -- computed straight from
  // seedPositions(linkable, links), deliberately NOT filtered off `positions`
  // or `dragged`. This feeds the re-fit effect below (auto-placed siblings
  // can land off-screen after a re-anchor -- see that effect's comment for
  // the full story); this memo exists to answer one question cheaply: did
  // the CONFIRMED layout actually change.
  //
  // Why not `linkable.filter((w) => !dragged[w.id]).map(...positions[w.id])`
  // (i.e. reuse `positions`, just excluding whatever's currently dragged):
  // `dragged` gains the just-moved node's id synchronously inside
  // `onDragFree`, at `dragfree` time -- before `savePosition.mutate`'s
  // network round-trip even starts, let alone finishes. Filtering by
  // `dragged` would make that node's entry vanish from the joined string at
  // that exact synchronous moment, which is itself a signature change --
  // firing a re-fit on literally every drag, including a one-pixel nudge of
  // an already-pinned node, before the drop is even confirmed to have
  // persisted. Computing straight from `seedPositions(linkable, links)`
  // instead means the entry set is always every `linkable` world (stable
  // regardless of what's mid-drag), and no VALUE in it can change until
  // `worlds`/`links` themselves change -- which only happens after
  // `useSaveGraphPosition`'s onSuccess invalidates `["worldGraph"]` and the
  // refetch actually lands: dragfree -> setDragged -> mutate -> (network) ->
  // invalidate -> refetch -> new worlds/links -> THIS memo recomputes. Only
  // then can a sibling's re-anchored coordinate actually be different from
  // what it was.
  //
  // Trade-off worth stating plainly: this still re-fits after ANY persisted
  // drag that changes a stored world's graph_x/graph_y, including a small
  // nudge of a world that was already pinned and never sent a neighbour
  // off-screen. There is no cheap way to ask "is anything now actually
  // outside the current viewport" short of measuring rendered bounding boxes
  // against the viewport rect, which is more machinery than this bug
  // warrants. The accepted cost is one settle-then-reframe per persisted
  // edit, not a jump mid-gesture and not a fit on every render.
  //
  // Keys sorted before joining so the signature reflects only actual
  // coordinate changes, never incidental object-key ordering.
  const seededSignature = useMemo(() => {
    const seeded = seedPositions(linkable, links);
    return Object.keys(seeded).sort()
      .map((id) => `${id}:${seeded[id].x},${seeded[id].y}`)
      .join('|');
  }, [linkable, links]);

  // A drag-to-connect gesture never writes anything by itself -- it only
  // proposes { fromId, edge, toId } here. The confirm panel is what calls
  // commitPending(). `selectedEdge` is the delete-side counterpart: which
  // drawn edge (identified by its Cytoscape id, `${fromId}|${edge}`) is
  // currently selected on the canvas -- it stores only that key, not a
  // snapshot of the row, so it can be re-checked against live `links` on
  // every render instead of outliving the row it pointed at.
  const [pending, setPending] = useState(null); // { fromId, toId, edge }
  const [selectedEdge, setSelectedEdge] = useState(null); // { fromId, edge }
  const [busy, setBusy] = useState(false);
  // The edgehandles instance, and whether the canvas is currently in
  // "draw a link" mode. cytoscape-edgehandles v4 has no separate handle
  // element on hover -- reading node_modules/cytoscape-edgehandles's bundled
  // source (cy-listeners.js's addCytoscapeListeners), the ONLY place that
  // calls this.start() is `cy.on('tapstart', 'node', e => { if (this.drawMode)
  // this.start(e.target); })`. Without drawMode on, tapping/dragging a node
  // only ever grabs and repositions it -- the gesture that creates a link
  // literally cannot begin. drawMode is therefore a real, mutually exclusive
  // mode switch (see toggleDrawMode in draw-mode.js: turning it on calls
  // `cy.autoungrabify(true)`, so nodes stop being draggable for repositioning
  // while link mode is on), not an optional nicety -- hence `linkMode` is
  // surfaced as an explicit toggle in the side panel below rather than left
  // implicit.
  //
  // The instance itself is a REF, not state, unlike `cy` above: `cy` has to
  // be state because it is a dependency an effect re-runs on. `eh` is read
  // only inside `toggleLinkMode`, an event handler that always reads
  // whatever `ehRef.current` holds at click time -- it does not need a
  // render to see a fresh value the way an effect's dependency array does.
  // Setting it via `setState` inside the effect below would itself be a
  // lint violation (react-hooks/set-state-in-effect: synchronous setState in
  // an effect body triggers a needless cascading re-render) with no
  // corresponding benefit here, since nothing renders differently once `eh`
  // exists except the Mode button's `disabled` state, which is driven off
  // `cy` instead (by the time `cy` is truthy in a committed render, this
  // effect has already run and populated the ref -- effects run before the
  // user can click anything).
  const ehRef = useRef(null);
  const [linkMode, setLinkMode] = useState(false);

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
        'background-fit': 'cover',
        'border-width': 1,
        'border-color': '#444',
        width: 64, height: 64,
        color: '#eee',
        'font-size': 11,
        'text-valign': 'bottom',
        'text-margin-y': 6,
      },
    },
    // The `data(...)` mappers live in their own rule, scoped to elements
    // that actually carry both fields: with link mode reachable (see the
    // interaction effect below), edgehandles now creates real ghost/preview
    // elements that match the plain `node`/`edge` selectors above but have
    // neither `ring` nor `label` in their data. Cytoscape's own apply.mjs
    // (`printMappingErr`, ~line 502) calls `util.warn(...)` -- "Do not
    // assign mappings to elements without corresponding data ... try a
    // `[field]` selector to limit scope" -- for every element a `data(x)`
    // mapper is applied to when it lacks that field, once per property per
    // restyle. `node[ring][label]` (rather than just `node[ring]`) is
    // belt-and-suspenders: on every node this component builds (see
    // `elements` above) the two fields are always set together, so gating on
    // either alone would work today, but gating on both doesn't depend on
    // that co-occurrence continuing to hold.
    {
      selector: 'node[ring][label]',
      style: { 'background-image': 'data(ring)', label: 'data(label)' },
    },
    {
      selector: 'edge',
      style: {
        'curve-style': 'straight',
        'line-color': '#4a9eff',
        width: 2,
        color: '#9bb',
        'font-size': 10,
        'text-background-color': '#12121f',
        'text-background-opacity': 0.8,
      },
    },
    // Same reasoning as `node[ring][label]` above: edgehandles' ghost and
    // preview edges have no `label` field.
    { selector: 'edge[label]', style: { label: 'data(label)' } },
    { selector: 'edge[mirrored = "false"]', style: { 'line-color': '#f59e0b', 'line-style': 'dashed' } },
    { selector: ':selected', style: { 'border-color': '#facc15', 'border-width': 3, 'line-color': '#facc15' } },
    // Edgehandles' own classes -- checked against node_modules/cytoscape-
    // edgehandles's bundled source (module 9, `start`/`preview`/`unpreview`):
    // '.eh-source' is added to the node a drag gesture started from.
    // '.eh-target' marks the node currently snapped-to as the prospective
    // target. '.eh-preview' is added to TWO different elements at once --
    // the snapped target node itself (`target.addClass('eh-preview')` inside
    // `preview()`'s `applyPreview`), AND the real, temporary rubber-band edge
    // `makePreview()` creates right after (`makeEdges(true)` classes the new
    // edge 'eh-preview' too) -- so this selector matches both a node and an
    // edge simultaneously; the `line-*` properties below are simply inert on
    // the node match, which is harmless but worth knowing before adding
    // anything less inert to this rule. '.eh-ghost-edge' is the line
    // tracking the cursor before anything is snapped. (`.eh-preview-active`
    // also exists in the library, applied to source/target/ghost during a
    // preview, but is left unstyled here -- '.eh-source'/'.eh-target'
    // already cover the node feedback it would add.) Without the four
    // selectors below the in-progress gesture is nearly invisible -- it
    // inherits the plain node/edge styles above.
    { selector: '.eh-source', style: { 'border-color': '#4a9eff', 'border-width': 3 } },
    { selector: '.eh-target', style: { 'border-color': '#22c55e', 'border-width': 3 } },
    { selector: '.eh-preview', style: { 'line-color': '#22c55e', 'line-style': 'solid' } },
    { selector: '.eh-ghost-edge', style: { 'line-color': '#4a9eff', 'line-style': 'dashed', width: 2 } },
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
  // `ehInstance.destroy()` undoes it in the cleanup so a re-run (or unmount)
  // never stacks a second edgehandles instance on the same core.
  //
  // `ehInstance.destroy()` alone is NOT enough if link mode is on when this
  // effect re-runs: reading node_modules/cytoscape-edgehandles's index.js,
  // `destroy()` is only `this.removeListeners()` -- it never touches
  // `drawMode` or calls `cy.autoungrabify(false)`. A fresh instance created
  // right after (this effect re-running) starts with its OWN `drawMode` back
  // at `false`, while the CORE is still ungrabified from the old instance's
  // `enableDrawMode()` call -- so neither dragging (still ungrabified) nor
  // linking (new instance isn't in draw mode) would work, and the toggle
  // button's own recovery path is a dead end: clicking it while `linkMode`
  // is (stale-)true calls `disableDrawMode()` on the NEW instance, whose
  // `prevUngrabifyState` was never captured (nothing called `enableDrawMode`
  // on it) and is `undefined` -- `cy.autoungrabify(undefined)` is a GETTER
  // (core/viewport.mjs: `if (bool !== undefined) { set } else { return
  // get }`), so it is a silent no-op rather than clearing the flag. The
  // cleanup below closes this instead of leaving it to a getter: it resets
  // `cy.autoungrabify(false)` and `linkMode` UNCONDITIONALLY, rather than
  // conditionally calling `disableDrawMode()` only `if (linkMode)` -- the
  // conditional form would depend on `linkMode` being current inside this
  // closure, but `linkMode` is deliberately not in this effect's dependency
  // array (adding it would re-run the whole listener setup on every mode
  // toggle for no reason), so the closure's `linkMode` would be whatever it
  // was when the effect last ran, not necessarily what's true "now". This
  // path is unreachable in production today (`cy` transitions once,
  // `savePosition.mutate` is stable, and React's dev-mode double-invoke of
  // effects lands before any user interaction, so `linkMode` is always still
  // `false` when it happens) -- but IS reachable under Vite Fast Refresh
  // while an admin has link mode on mid-edit, which is exactly Task 10's
  // environment.
  //
  // `snapFrequency: 15` is passed explicitly, not left to the documented
  // default: reading node_modules/cytoscape-edgehandles's index.js, the snap
  // throttle is built from the RAW options object (`1000 / options.
  // snapFrequency`), not a version merged with defaults first. `{ snap: true }`
  // alone leaves `options.snapFrequency` undefined, so the throttle wait is
  // `1000 / undefined` = NaN, which lodash.throttle treats as a 0ms wait --
  // the snap scan (a walk over every node's distance to the cursor) would run
  // on literally every 'tapdrag' tick instead of at ~15Hz. `snap: true` is
  // kept even though it's also the library default, purely as documentation.
  //
  // ehcomplete's 4th argument is technically a Cytoscape *collection*
  // (`cy.collection().merge(...)` internally), not a single edge element --
  // but `.remove()` is a Collection method that removes every element in it,
  // so calling it here is correct regardless: this graph is not compound, so
  // the collection always holds exactly the one preview edge edgehandles just
  // added. It is removed immediately because this UI confirms before it
  // writes anything -- the pending proposal, not the edge itself, is what
  // gets shown. `ehInstance.disableDrawMode()` runs right after: it restores
  // `cy.autoungrabify()` to whatever it was before link mode was switched on
  // (see toggleDrawMode in draw-mode.js -- `enableDrawMode` snapshots the
  // PRIOR autoungrabify state and `disableDrawMode` restores exactly that
  // value, which is `false` here since nothing else in this component ever
  // sets it), so node dragging/repositioning (and its `dragfree` persistence)
  // is usable again the moment a link gesture completes, without the admin
  // having to remember to flip the toggle back off themselves.
  //
  // `onSelect` ignores any edge id without a `|`: `elements` above is the
  // only place this component builds a real edge, and it always ids one
  // `${fromId}|${edge}`. Edgehandles' own preview/ghost edges get
  // auto-generated ids with no `|` in them. Before link mode could actually
  // run (see the `eh`/`linkMode` comment), that distinction was moot because
  // those temporary edges are `.remove()`d before `select` could ever fire on
  // one -- but they DO briefly exist as real elements mid-gesture, so this
  // guard is defensive against a future gesture change routing a select event
  // through here before cleanup.
  useEffect(() => {
    if (!cy) return undefined;
    const onDragFree = (evt) => {
      const node = evt.target;
      const { x, y } = node.position();
      setDragged((prev) => ({ ...prev, [node.id()]: { x, y } }));
      savePosition.mutate({ id: node.id(), x, y });
    };
    const ehInstance = cy.edgehandles({ snap: true, snapFrequency: 15 });
    ehRef.current = ehInstance;
    const onComplete = (evt, source, target, addedEles) => {
      addedEles.remove();
      ehInstance.disableDrawMode();
      setLinkMode(false);
      const a = source.position();
      const b = target.position();
      setPending({ fromId: source.id(), toId: target.id(), edge: compassFromDelta(b.x - a.x, b.y - a.y) });
    };
    const onSelect = (evt) => {
      const id = evt.target.id();
      if (!id.includes('|')) return;
      const [fromId, edge] = id.split('|');
      setSelectedEdge({ fromId, edge });
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
      ehInstance.destroy();
      ehRef.current = null;
      // destroy() leaves draw mode's autoungrabify set -- see the comment
      // above. Unconditional, not `linkMode && ...disableDrawMode()`: see
      // above for why the conditional form is the less robust of the two.
      cy.autoungrabify(false);
      setLinkMode(false);
    };
  }, [cy, savePosition.mutate]);

  // `preset` (the layout below) only fits the viewport once, at mount:
  // react-cytoscapejs's patchLayout only re-runs a layout when the `layout`
  // prop itself diffs, and it diffs by VALUE (shallowObjDiff), so
  // `{ name: 'preset' }` compared to the exact same object on every
  // subsequent render is never "different" -- the layout (and its implicit
  // `fit: true`) never runs again after mount. Meanwhile `seedPositions`
  // legitimately re-measures every auto-placed (unsaved) world relative to
  // whichever of its neighbours DOES have a saved position -- so the moment
  // an admin drags a previously-unpositioned world and that drag persists,
  // its unsaved siblings can be walked to a genuinely different cell, one
  // that may be outside whatever the viewport was fit to at mount. Without
  // this effect that sibling sits off-screen until a full page reload.
  //
  // Keyed on `seededSignature`, not `positions`/`dragged`/every render: see
  // that memo's own comment for why it only changes once a drag's mutation
  // is confirmed by a refetch, never mid-gesture and never merely because a
  // node entered `dragged`.
  //
  // `cy.fit(undefined, 30)` on an empty collection is a harmless no-op --
  // confirmed in cytoscape/src/core/viewport.mjs's `getFitViewport`:
  // `elements` defaults to `this.mutableElements()` when omitted, and
  // `if (elements.empty()) return;` fires before `fit()` ever reads or
  // writes zoom/pan -- so this is safe to call before any world has
  // rendered (e.g. an empty or entirely-unbounded world list).
  useEffect(() => {
    if (!cy) return undefined;
    cy.fit(undefined, 30);
    return undefined;
  }, [cy, seededSignature]);

  // Toggling link mode on ungrabifies every node (see the `ehRef`/`linkMode`
  // state comment) -- so this is a genuine mode switch the admin has to
  // choose, not two gestures that happily coexist. Reads `ehRef.current` at
  // click time rather than closing over a state value.
  const toggleLinkMode = () => {
    const eh = ehRef.current;
    if (!eh) return;
    if (linkMode) {
      eh.disableDrawMode();
      setLinkMode(false);
    } else {
      eh.enableDrawMode();
      setLinkMode(true);
    }
  };

  const nameOf = (id) => (worlds.find((w) => w.id === id) || {}).name || id;
  const replaced = pending
    ? linksReplacedBy({ links, fromId: pending.fromId, edge: pending.edge, toId: pending.toId })
    : [];
  // Re-checked against the current `links` on every render, rather than
  // trusting whatever `selectedEdge` was set to at select-time: if the link
  // disappears underneath the selection (another admin, another tab, or this
  // admin's own commit), `selectedRow` goes undefined and the panel below
  // stops rendering itself -- it cannot outlive the row it points at.
  const selectedRow = selectedEdge
    && links.find((l) => l.from_world_id === selectedEdge.fromId && l.edge === selectedEdge.edge);

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
            // Cytoscape's own default maxZoom is 1e50 (effectively
            // unbounded) -- `fit()`'s zoom crop (viewport.mjs: `zoom = zoom
            // > this._private.maxZoom ? this._private.maxZoom : zoom`) only
            // helps if something has actually set a real ceiling. With a
            // one- or two-node graph that meant fitting to roughly 6x/3.7x
            // zoom. Now that fits happen repeatedly (see the re-fit effect
            // below), not just once at mount, that is more likely to be hit.
            // `maxZoom` is a supported, patched prop -- confirmed in
            // react-cytoscapejs/src/types.js (declared in `types`, which
            // `CytoscapeComponent.propTypes` is) and src/patch.js (`maxZoom`
            // is one of the "simple keys that can be patched directly", via
            // `cy.maxZoom(value)`).
            maxZoom={1.5}
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
                <Button $bg="#555" onClick={() => setPending(null)} disabled={busy}>Cancel</Button>
              </Row>
            </Card>
          )}
          {selectedRow && (
            <Card>
              <strong style={{ color: '#aaa' }}>Selected link</strong>
              <Row>
                {nameOf(selectedRow.from_world_id)} {selectedRow.edge} → {nameOf(selectedRow.to_world_id)}
              </Row>
              <Warn>Removing this clears BOTH directions, and rebuilds terrain for both worlds.</Warn>
              <Row>
                <Button
                  $bg="#ef4444"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await clearLink.mutateAsync({ id: selectedRow.from_world_id, edge: selectedRow.edge });
                      setSelectedEdge(null);
                    } catch {
                      // useClearLink already toasts the underlying failure;
                      // this only stops the rejection from surfacing as an
                      // unhandled promise rejection in the console, which
                      // would otherwise be noise Task 10's browser pass has
                      // to sift a real error out of.
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
            <strong style={{ color: '#aaa' }}>Mode</strong>
            <Row>
              <Button $bg={linkMode ? '#22c55e' : '#555'} onClick={toggleLinkMode} disabled={!cy}>
                {linkMode ? 'Link mode: on' : 'Link mode: off'}
              </Button>
            </Row>
            <Dim>
              {linkMode
                ? 'Drag from one world to another to propose a link. Nodes cannot be repositioned while this is on.'
                : 'Drag a world to reposition it. Turn on link mode to draw a new link instead.'}
            </Dim>
          </Card>
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
