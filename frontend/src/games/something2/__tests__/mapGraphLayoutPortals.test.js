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
    expect(positions['dungeon-1'].x).toBeCloseTo(0, 5);
    expect(positions['dungeon-1'].y).toBeGreaterThan(0);
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
    expect(positions['dungeon-2'].y).toBeGreaterThan(positions['dungeon-1'].y);
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
});
