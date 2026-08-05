import { describe, it, expect } from 'vitest';
import { seedPositions } from '../mapGraphLayout.js';

describe('portal-linked worlds get an off-grid cluster near their entrance', () => {
  it('places a single dungeon level directly below its entrance world', () => {
    const worlds = [
      { id: 'surface', graph_x: 0, graph_y: 0, is_entry: true },
      { id: 'dungeon-1', graph_x: null, graph_y: null, is_entry: false },
    ];
    const links = [
      { from_world_id: 'surface', edge: 'PORTAL', to_world_id: 'dungeon-1' },
    ];
    const positions = seedPositions(worlds, links);
    expect(positions.surface).toEqual({ x: 0, y: 0 });
    expect(positions['dungeon-1']).toEqual({ x: 0, y: 220 });
  });

  it('a chain of dungeon levels stacks further down at each hop', () => {
    const worlds = [
      { id: 'surface', graph_x: 0, graph_y: 0, is_entry: true },
      { id: 'dungeon-1', graph_x: null, graph_y: null, is_entry: false },
      { id: 'dungeon-2', graph_x: null, graph_y: null, is_entry: false },
    ];
    const links = [
      { from_world_id: 'surface', edge: 'PORTAL', to_world_id: 'dungeon-1' },
      { from_world_id: 'dungeon-1', edge: 'PORTAL', to_world_id: 'dungeon-2' },
    ];
    const positions = seedPositions(worlds, links);
    expect(positions['dungeon-1']).toEqual({ x: 0, y: 220 });
    expect(positions['dungeon-2']).toEqual({ x: 0, y: 440 });
  });

  it('branching levels spread horizontally instead of colliding', () => {
    const worlds = [
      { id: 'surface', graph_x: 0, graph_y: 0, is_entry: true },
      { id: 'dungeon-1a', graph_x: null, graph_y: null, is_entry: false },
      { id: 'dungeon-1b', graph_x: null, graph_y: null, is_entry: false },
    ];
    const links = [
      { from_world_id: 'surface', edge: 'PORTAL', to_world_id: 'dungeon-1a' },
      { from_world_id: 'surface', edge: 'PORTAL', to_world_id: 'dungeon-1b' },
    ];
    const positions = seedPositions(worlds, links);
    expect(positions['dungeon-1a'].x).not.toEqual(positions['dungeon-1b'].x);
    expect(positions['dungeon-1a'].y).toEqual(positions['dungeon-1b'].y);
  });

  it('a dungeon cluster never lands on a cell an existing compass-grid world already occupies', () => {
    const worlds = [
      { id: 'surface', graph_x: 0, graph_y: 0, is_entry: true },
      { id: 'south', graph_x: 0, graph_y: 220, is_entry: false }, // directly below surface already
      { id: 'dungeon-1', graph_x: null, graph_y: null, is_entry: false },
    ];
    const links = [
      { from_world_id: 'surface', edge: 'S', to_world_id: 'south' },
      { from_world_id: 'surface', edge: 'PORTAL', to_world_id: 'dungeon-1' },
    ];
    const positions = seedPositions(worlds, links);
    const southKey = `${Math.round(positions.south.x / 220)},${Math.round(positions.south.y / 220)}`;
    const dungeonKey = `${Math.round(positions['dungeon-1'].x / 220)},${Math.round(positions['dungeon-1'].y / 220)}`;
    expect(dungeonKey).not.toEqual(southKey);
  });

  it('a spec with no portals at all lays out exactly as before (no regression)', () => {
    const worlds = [
      { id: 'surface', graph_x: 0, graph_y: 0, is_entry: true },
      { id: 'east', graph_x: null, graph_y: null, is_entry: false },
    ];
    const links = [{ from_world_id: 'surface', edge: 'E', to_world_id: 'east' }];
    const positions = seedPositions(worlds, links);
    expect(positions.east).toEqual({ x: 220, y: 0 });
  });

  // A portal source that is itself compass-disconnected (never anchored by
  // the main walk, e.g. a dungeon hub with no compass links of its own yet)
  // used to lose this ordering fight against list order: the disconnected-
  // root loop would seat whichever world it reached first as its own
  // independent root, and if that was the dungeon (a portal TARGET with no
  // compass edges) rather than its source, the dungeon got stranded beside
  // its entrance instead of clustered beneath it -- and never got a second
  // chance, since placePortalClusters skips any child that already has a
  // cell. GET /api/world-graph orders worlds by created_at DESC, so a
  // dungeon created after its still-unlinked hub sorts BEFORE it in the
  // array this function receives, making this the realistic case, not an
  // edge case.
  it('clusters correctly even when the portal source is itself compass-disconnected and sorts after its target', () => {
    const worlds = [
      { id: 'dungeon-1', graph_x: null, graph_y: null, is_entry: false }, // target, listed first
      { id: 'cave-entrance', graph_x: null, graph_y: null, is_entry: false }, // source, listed second
    ];
    const links = [
      { from_world_id: 'cave-entrance', edge: 'PORTAL', to_world_id: 'dungeon-1' },
    ];
    const positions = seedPositions(worlds, links);
    expect(positions['cave-entrance']).toEqual({ x: 0, y: 0 });
    expect(positions['dungeon-1']).toEqual({ x: 0, y: 220 });
  });

  it('clusters a 3-world compass-disconnected chain correctly regardless of list order', () => {
    const worlds = [
      { id: 'c', graph_x: null, graph_y: null, is_entry: false },
      { id: 'b', graph_x: null, graph_y: null, is_entry: false },
      { id: 'a', graph_x: null, graph_y: null, is_entry: false }, // true root, listed last
    ];
    const links = [
      { from_world_id: 'a', edge: 'PORTAL', to_world_id: 'b' },
      { from_world_id: 'b', edge: 'PORTAL', to_world_id: 'c' },
    ];
    const positions = seedPositions(worlds, links);
    expect(positions.a).toEqual({ x: 0, y: 0 });
    expect(positions.b).toEqual({ x: 0, y: 220 });
    expect(positions.c).toEqual({ x: 0, y: 440 });
  });

  // A cycle means no world can ever win the "wait for my source to seat
  // first" rule -- every world in the cycle is blocked on every other. The
  // fallback (seat the first still-unpositioned world in list order,
  // breaking the tie) must still terminate and place everyone, rather than
  // deadlocking and leaving the cycle's worlds permanently unpositioned.
  it('breaks a 2-world portal cycle by seating the first list entry, instead of leaving both unplaced', () => {
    const worlds = [
      { id: 'a', graph_x: null, graph_y: null, is_entry: false },
      { id: 'b', graph_x: null, graph_y: null, is_entry: false },
    ];
    const links = [
      { from_world_id: 'a', edge: 'PORTAL', to_world_id: 'b' },
      { from_world_id: 'b', edge: 'PORTAL', to_world_id: 'a' },
    ];
    const positions = seedPositions(worlds, links);
    expect(positions.a).toEqual({ x: 0, y: 0 });
    expect(positions.b).toEqual({ x: 0, y: 220 });
  });

  it('breaks a 3-world portal cycle and still cascades the rest of the loop from the tie-break', () => {
    const worlds = [
      { id: 'c', graph_x: null, graph_y: null, is_entry: false },
      { id: 'b', graph_x: null, graph_y: null, is_entry: false },
      { id: 'a', graph_x: null, graph_y: null, is_entry: false },
    ];
    const links = [
      { from_world_id: 'a', edge: 'PORTAL', to_world_id: 'b' },
      { from_world_id: 'b', edge: 'PORTAL', to_world_id: 'c' },
      { from_world_id: 'c', edge: 'PORTAL', to_world_id: 'a' },
    ];
    const positions = seedPositions(worlds, links);
    // Tie-break seats the first list entry ('c') as the row-0 root; the
    // cycle's other two links then cascade from there in graph order
    // (c -> a -> b), not list order.
    expect(positions.c).toEqual({ x: 0, y: 0 });
    expect(positions.a).toEqual({ x: 0, y: 220 });
    expect(positions.b).toEqual({ x: 0, y: 440 });
  });
});
