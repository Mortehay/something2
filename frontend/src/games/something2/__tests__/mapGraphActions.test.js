import { describe, it, expect } from 'vitest';
import { planLinkChange } from '../mapGraphActions.js';

const L = (from, edge, to) => ({ from_world_id: from, edge, to_world_id: to });

describe('planLinkChange', () => {
  it('creates directly when both slots are free', () => {
    expect(planLinkChange({ links: [], fromId: 'a', edge: 'E', toId: 'b' })).toEqual({
      clears: [],
      create: { fromId: 'a', edge: 'E', toId: 'b' },
    });
  });

  // setLink would overwrite a.E and leave c.W->a dangling, so clear it first.
  it("clears the source's occupied slot before creating", () => {
    const plan = planLinkChange({ links: [L('a', 'E', 'c'), L('c', 'W', 'a')], fromId: 'a', edge: 'E', toId: 'b' });
    expect(plan.clears).toContainEqual({ fromId: 'a', edge: 'E' });
    expect(plan.create).toEqual({ fromId: 'a', edge: 'E', toId: 'b' });
  });

  it("clears the TARGET's opposing slot too", () => {
    const plan = planLinkChange({ links: [L('b', 'W', 'd'), L('d', 'E', 'b')], fromId: 'a', edge: 'E', toId: 'b' });
    expect(plan.clears).toContainEqual({ fromId: 'b', edge: 'W' });
  });

  it('clears both when both are occupied', () => {
    const links = [L('a', 'E', 'c'), L('c', 'W', 'a'), L('b', 'W', 'd'), L('d', 'E', 'b')];
    const plan = planLinkChange({ links, fromId: 'a', edge: 'E', toId: 'b' });
    expect(plan.clears).toHaveLength(2);
  });

  it('is a no-op create when the exact link already exists', () => {
    const plan = planLinkChange({ links: [L('a', 'E', 'b'), L('b', 'W', 'a')], fromId: 'a', edge: 'E', toId: 'b' });
    expect(plan.clears).toEqual([]);
    expect(plan.create).toEqual({ fromId: 'a', edge: 'E', toId: 'b' });
  });
});
