import { describe, it, expect } from 'vitest';
import { seedPositions } from '../mapGraphLayout.js';

// PRODUCTION SHAPE. setPortalLink (backend/src/services/mapLinks.js) always
// writes BOTH rows -- the declared one and a mirror with from/to swapped
// outright -- and GET /api/world-graph serves them uncollapsed. So a portal
// link ALWAYS reaches this module as two rows, and every fixture below uses
// this helper rather than a single row.
//
// This matters, it is not pedantry: with mirrored rows both endpoints of a
// pair are each other's portal target, so both are simultaneously "blocked"
// by seedPositions' don't-seat-a-target-before-its-source rule and neither
// can win it. An earlier revision of this file asserted one-directional
// fixtures, and the two shapes genuinely diverge -- the one-way version of
// the 'compass-disconnected source' case below seats cave-entrance at the
// root, the mirrored version seats dungeon-1 there instead. Every expectation
// here was taken by running the real seedPositions against the mirrored
// input, not from an assumption about what it ought to do.
const portal = (a, b) => [
  { from_world_id: a, edge: 'PORTAL', to_world_id: b },
  { from_world_id: b, edge: 'PORTAL', to_world_id: a },
];
// Compass links mirror too (setLink writes (from,edge) and (to,opposite)).
const OPP = { N: 'S', S: 'N', E: 'W', W: 'E' };
const compass = (a, edge, b) => [
  { from_world_id: a, edge, to_world_id: b },
  { from_world_id: b, edge: OPP[edge], to_world_id: a },
];
const unplaced = (id, extra = {}) => ({ id, graph_x: null, graph_y: null, is_entry: false, ...extra });

describe('portal-linked worlds get an off-grid cluster near their entrance', () => {
  it('places a single dungeon level directly below its entrance world', () => {
    const worlds = [
      { id: 'surface', graph_x: 0, graph_y: 0, is_entry: true },
      unplaced('dungeon-1'),
    ];
    const positions = seedPositions(worlds, portal('surface', 'dungeon-1'));
    expect(positions.surface).toEqual({ x: 0, y: 0 });
    expect(positions['dungeon-1']).toEqual({ x: 0, y: 220 });
  });

  it('a chain of dungeon levels stacks further down at each hop', () => {
    const worlds = [
      { id: 'surface', graph_x: 0, graph_y: 0, is_entry: true },
      unplaced('dungeon-1'),
      unplaced('dungeon-2'),
    ];
    const links = [...portal('surface', 'dungeon-1'), ...portal('dungeon-1', 'dungeon-2')];
    const positions = seedPositions(worlds, links);
    expect(positions['dungeon-1']).toEqual({ x: 0, y: 220 });
    expect(positions['dungeon-2']).toEqual({ x: 0, y: 440 });
  });

  it('branching levels spread horizontally instead of colliding', () => {
    const worlds = [
      { id: 'surface', graph_x: 0, graph_y: 0, is_entry: true },
      unplaced('dungeon-1a'),
      unplaced('dungeon-1b'),
    ];
    const links = [...portal('surface', 'dungeon-1a'), ...portal('surface', 'dungeon-1b')];
    const positions = seedPositions(worlds, links);
    expect(positions['dungeon-1a']).toEqual({ x: 0, y: 220 });
    expect(positions['dungeon-1b']).toEqual({ x: 220, y: 220 });
  });

  it('a dungeon cluster never lands on a cell an existing compass-grid world already occupies', () => {
    const worlds = [
      { id: 'surface', graph_x: 0, graph_y: 0, is_entry: true },
      { id: 'south', graph_x: 0, graph_y: 220, is_entry: false }, // directly below surface already
      unplaced('dungeon-1'),
    ];
    const links = [...compass('surface', 'S', 'south'), ...portal('surface', 'dungeon-1')];
    const positions = seedPositions(worlds, links);
    expect(positions.south).toEqual({ x: 0, y: 220 });
    expect(positions['dungeon-1']).toEqual({ x: 220, y: 220 });
  });

  it('a spec with no portals at all lays out exactly as before (no regression)', () => {
    const worlds = [
      { id: 'surface', graph_x: 0, graph_y: 0, is_entry: true },
      unplaced('east'),
    ];
    const positions = seedPositions(worlds, compass('surface', 'E', 'east'));
    expect(positions.east).toEqual({ x: 220, y: 0 });
  });

  // ---------------------------------------------------------------------
  // THE DOMINANT REAL CASE: nothing has been dragged yet, so no world has a
  // stored graph_x/graph_y at all, and the entrance world is reached only
  // through the disconnected-root loop. validateMapSpec (backend/seeds/
  // mapSpec.js) guarantees a seeded map has EXACTLY ONE is_entry world and
  // that every other world is reachable from it (its BFS walks portal
  // adjacency, not just compass links) -- and seedPositions sorts is_entry
  // first when choosing roots. That sort, not compass anchoring, is what
  // makes these deterministic: a portal-connected entrance world is allowed
  // to omit `grid` entirely in a spec, so it may well have no stored
  // position of its own.
  //
  // GET /api/world-graph orders worlds by created_at DESC, so dungeons
  // created after their hub arrive BEFORE it in the array -- these fixtures
  // list them that way on purpose.
  // ---------------------------------------------------------------------
  it('clusters an unstored is_entry hub above its dungeon chain, whatever the list order', () => {
    const worlds = [
      unplaced('dungeon-2'),
      unplaced('dungeon-1'),
      unplaced('surface', { is_entry: true }),
    ];
    const links = [...portal('surface', 'dungeon-1'), ...portal('dungeon-1', 'dungeon-2')];
    const positions = seedPositions(worlds, links);
    expect(positions).toEqual({
      surface: { x: 0, y: 0 },
      'dungeon-1': { x: 0, y: 220 },
      'dungeon-2': { x: 0, y: 440 },
    });
  });

  it('clusters an unstored is_entry hub above two sibling branches, whatever the list order', () => {
    const worlds = [
      unplaced('dungeon-1b'),
      unplaced('dungeon-1a'),
      unplaced('surface', { is_entry: true }),
    ];
    const links = [...portal('surface', 'dungeon-1a'), ...portal('surface', 'dungeon-1b')];
    const positions = seedPositions(worlds, links);
    expect(positions).toEqual({
      surface: { x: 0, y: 0 },
      'dungeon-1a': { x: 0, y: 220 },
      'dungeon-1b': { x: 220, y: 220 },
    });
  });

  it('clusters a branch two hops deep beneath an unstored is_entry hub', () => {
    const worlds = [
      unplaced('d2b'), unplaced('d2a'), unplaced('d1'),
      unplaced('surface', { is_entry: true }),
    ];
    const links = [
      ...portal('surface', 'd1'), ...portal('d1', 'd2a'), ...portal('d1', 'd2b'),
    ];
    const positions = seedPositions(worlds, links);
    // One row per hop, siblings in distinct columns, nothing stacked. The
    // sibling pair sits one column left of centre because d1's child list
    // also contains its own mirror row back to `surface` (already placed, so
    // skipped) and that inflates the centring divisor -- cosmetic, and
    // deterministic.
    expect(positions).toEqual({
      surface: { x: 0, y: 0 },
      d1: { x: 0, y: 220 },
      d2a: { x: -220, y: 440 },
      d2b: { x: 0, y: 440 },
    });
  });

  // The Task 9 fix ("don't seat a portal TARGET as its own root while its
  // source is still unplaced") still earns its keep with mirrored rows, but
  // only where the is_entry sort cannot already decide the order -- e.g. a
  // graph assembled by hand through the admin UI, where no world is flagged
  // is_entry at all. Here `surface` is the only world that is nobody's portal
  // target, so it is the only unblocked root; it must seat first and let the
  // compass walk plus placePortalClusters cascade the rest. Without the
  // guard, `dungeon-1` (listed first) grabs row 0 for itself and the whole
  // graph unfolds inverted and stretched over three rows -- verified by
  // running this fixture against a guard-disabled copy of the module.
  it('lets an unblocked root seat first even though a portal target is listed before it', () => {
    const worlds = [unplaced('dungeon-1'), unplaced('east'), unplaced('surface')];
    const links = [...compass('surface', 'E', 'east'), ...portal('east', 'dungeon-1')];
    const positions = seedPositions(worlds, links);
    expect(positions).toEqual({
      surface: { x: 0, y: 0 },
      east: { x: 220, y: 0 },
      'dungeon-1': { x: 220, y: 220 },
    });
  });

  // ---------------------------------------------------------------------
  // ARBITRARY-BUT-DETERMINISTIC. Once both directions are present, a portal
  // pair is a 2-cycle: each endpoint is the other's target, so both are
  // blocked and the "wait for your source" rule can never be satisfied by
  // either. With neither endpoint anchored (no stored position) and neither
  // flagged is_entry, the graph carries no information about which one is
  // "the hub" -- so the tie-break simply seats the first still-unplaced world
  // in list order. That is arbitrary, but it is stable for a given input,
  // which is all this layer owes its caller. A validated spec cannot reach
  // this state (exactly one is_entry world, reachable from everything), which
  // is why the cases above rather than this one describe production.
  // ---------------------------------------------------------------------
  it('breaks a fully-mutual, fully-unanchored portal pair by list order', () => {
    const worlds = [unplaced('dungeon-1'), unplaced('cave-entrance')];
    const positions = seedPositions(worlds, portal('cave-entrance', 'dungeon-1'));
    expect(positions).toEqual({
      'dungeon-1': { x: 0, y: 0 },
      'cave-entrance': { x: 0, y: 220 },
    });
  });

  it('places every world of a mirrored 3-world portal cycle instead of deadlocking', () => {
    const worlds = [unplaced('c'), unplaced('b'), unplaced('a')];
    const links = [...portal('a', 'b'), ...portal('b', 'c'), ...portal('c', 'a')];
    const positions = seedPositions(worlds, links);
    // Tie-break seats 'c' (first in list order); the cycle then cascades from
    // there in graph order, and every member ends up with a distinct cell.
    expect(positions).toEqual({
      c: { x: 0, y: 0 },
      b: { x: 0, y: 220 },
      a: { x: 220, y: 220 },
    });
    const cells = Object.values(positions).map((p) => `${p.x},${p.y}`);
    expect(new Set(cells).size).toBe(3);
  });

  // The schema permits a lone PORTAL row (the World Map lints it as
  // 'missing-mirror'); setPortalLink never writes one, but a hand-edited or
  // half-deleted row could. Layout must still place both worlds sanely.
  it('still clusters a one-way portal row, which the schema permits', () => {
    const worlds = [
      unplaced('dungeon-1'),
      { id: 'hub', graph_x: 0, graph_y: 0, is_entry: true },
    ];
    const links = [{ from_world_id: 'hub', edge: 'PORTAL', to_world_id: 'dungeon-1' }];
    const positions = seedPositions(worlds, links);
    expect(positions).toEqual({ hub: { x: 0, y: 0 }, 'dungeon-1': { x: 0, y: 220 } });
  });
});
