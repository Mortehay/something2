import { describe, it, expect } from 'vitest';
import { OPPOSITE, compassFromDelta, seedPositions } from '../mapGraphLayout.js';

describe('compassFromDelta', () => {
  // Screen y grows DOWNWARD, so a node below the source is South.
  it('maps the dominant axis to a compass edge', () => {
    expect(compassFromDelta(100, 10)).toBe('E');
    expect(compassFromDelta(-100, 10)).toBe('W');
    expect(compassFromDelta(10, 100)).toBe('S');
    expect(compassFromDelta(10, -100)).toBe('N');
  });

  it('resolves a perfect diagonal tie to the horizontal axis', () => {
    expect(compassFromDelta(50, 50)).toBe('E');
    expect(compassFromDelta(-50, 50)).toBe('W');
    expect(compassFromDelta(-50, -50)).toBe('W');
  });

  it('treats a zero delta as East rather than crashing', () => {
    expect(compassFromDelta(0, 0)).toBe('E');
  });

  it('is consistent with OPPOSITE', () => {
    expect(OPPOSITE[compassFromDelta(100, 0)]).toBe('W');
    expect(OPPOSITE[compassFromDelta(0, 100)]).toBe('N');
  });
});

const W = (id, extra = {}) => ({ id, name: id, width: 24, height: 24, is_entry: false, biomes: [], graph_x: null, graph_y: null, ...extra });

describe('seedPositions', () => {
  it('preserves stored positions untouched', () => {
    const worlds = [W('a', { graph_x: 17, graph_y: -3 })];
    expect(seedPositions(worlds, [])).toEqual({ a: { x: 17, y: -3 } });
  });

  it('walks links from the entry world, one cell per compass edge', () => {
    const worlds = [W('a', { is_entry: true }), W('b'), W('c')];
    const links = [
      { from_world_id: 'a', edge: 'E', to_world_id: 'b' },
      { from_world_id: 'b', edge: 'S', to_world_id: 'c' },
    ];
    const pos = seedPositions(worlds, links, { cell: 100 });
    expect(pos.a).toEqual({ x: 0, y: 0 });
    expect(pos.b).toEqual({ x: 100, y: 0 });   // East = +x
    expect(pos.c).toEqual({ x: 100, y: 100 }); // South = +y (screen down)
  });

  it('gives every world a position, including unlinked ones', () => {
    const worlds = [W('a', { is_entry: true }), W('lonely')];
    const pos = seedPositions(worlds, [], { cell: 100 });
    expect(Object.keys(pos).sort()).toEqual(['a', 'lonely']);
    expect(Number.isFinite(pos.lonely.x)).toBe(true);
    expect(Number.isFinite(pos.lonely.y)).toBe(true);
  });

  it('never stacks two worlds on the same point', () => {
    // The live topology: every edge of a points at b and vice versa. Only the
    // first edge can be honoured; the rest would collide.
    const worlds = [W('a', { is_entry: true }), W('b')];
    const links = ['N', 'E', 'S', 'W'].map((edge) => ({ from_world_id: 'a', edge, to_world_id: 'b' }));
    const pos = seedPositions(worlds, links, { cell: 100 });
    expect(`${pos.a.x},${pos.a.y}`).not.toBe(`${pos.b.x},${pos.b.y}`);
  });

  it('is deterministic for the same input', () => {
    const worlds = [W('a', { is_entry: true }), W('b'), W('c')];
    const links = [{ from_world_id: 'a', edge: 'E', to_world_id: 'b' }];
    expect(seedPositions(worlds, links)).toEqual(seedPositions(worlds, links));
  });

  it('ignores links that name a world not in the list', () => {
    const worlds = [W('a', { is_entry: true })];
    const links = [{ from_world_id: 'a', edge: 'E', to_world_id: 'ghost' }];
    const pos = seedPositions(worlds, links, { cell: 100 });
    expect(pos).toEqual({ a: { x: 0, y: 0 } });
  });

  it('handles no entry world by starting from the first unpositioned one', () => {
    const worlds = [W('a'), W('b')];
    const links = [{ from_world_id: 'a', edge: 'E', to_world_id: 'b' }];
    const pos = seedPositions(worlds, links, { cell: 100 });
    expect(pos.a).toEqual({ x: 0, y: 0 });
    expect(pos.b).toEqual({ x: 100, y: 0 });
  });

  // The exact case the review reproduced: the walk's start cell and a stored
  // position both resolved to (0,0).
  it('never seeds a world on top of a stored one', () => {
    const worlds = [W('a', { is_entry: true }), W('b', { graph_x: 0, graph_y: 0 })];
    const pos = seedPositions(worlds, []);
    expect(`${pos.a.x},${pos.a.y}`).not.toBe(`${pos.b.x},${pos.b.y}`);
  });

  it('does not walk a neighbour into a grid-aligned stored position', () => {
    // b sits exactly one default cell east of the origin, which is where the
    // a -E-> c link would otherwise put c.
    const worlds = [W('a', { is_entry: true }), W('b', { graph_x: 220, graph_y: 0 }), W('c')];
    const links = [{ from_world_id: 'a', edge: 'E', to_world_id: 'c' }];
    const pos = seedPositions(worlds, links);
    expect(pos.b).toEqual({ x: 220, y: 0 });
    expect(`${pos.c.x},${pos.c.y}`).not.toBe('220,0');
  });

  it('gives every world a distinct coordinate across mixed input', () => {
    const worlds = [
      W('entry', { is_entry: true }), W('east'), W('south'),
      W('placed', { graph_x: 0, graph_y: 0 }), W('alsoPlaced', { graph_x: 440, graph_y: 220 }),
      W('orphan1'), W('orphan2'),
    ];
    const links = [
      { from_world_id: 'entry', edge: 'E', to_world_id: 'east' },
      { from_world_id: 'east', edge: 'S', to_world_id: 'south' },
    ];
    const pos = seedPositions(worlds, links);
    const points = worlds.map((w) => `${pos[w.id].x},${pos[w.id].y}`);
    expect(new Set(points).size).toBe(worlds.length);
  });

  it('anchors the walk at a stored world instead of re-routing around it', () => {
    // The regression this guards: the admin drags A, so A gains a stored
    // position. Its neighbours must stay measured from A -- previously the walk
    // restarted from B and dumped C into a spare row, teleporting two nodes from
    // one drag of a third and inventing direction-mismatch warnings.
    const worlds = [W('a', { is_entry: true, graph_x: 100, graph_y: 200 }), W('b'), W('c')];
    const links = [
      { from_world_id: 'a', edge: 'E', to_world_id: 'b' },
      { from_world_id: 'a', edge: 'S', to_world_id: 'c' },
    ];
    const pos = seedPositions(worlds, links, { cell: 100 });
    expect(pos.a).toEqual({ x: 100, y: 200 });
    expect(pos.b).toEqual({ x: 200, y: 200 });
    expect(pos.c).toEqual({ x: 100, y: 300 });
  });

  it('walks through a stored world to reach what lies beyond it', () => {
    const worlds = [W('a', { is_entry: true }), W('b', { graph_x: 0, graph_y: 0 }), W('c')];
    const links = [
      { from_world_id: 'b', edge: 'E', to_world_id: 'c' },
      { from_world_id: 'a', edge: 'E', to_world_id: 'b' },
    ];
    const pos = seedPositions(worlds, links, { cell: 100 });
    expect(pos.b).toEqual({ x: 0, y: 0 });
    expect(pos.c).toEqual({ x: 100, y: 0 });
  });
});
