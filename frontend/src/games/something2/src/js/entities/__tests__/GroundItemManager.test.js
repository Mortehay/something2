import { describe, it, expect } from 'vitest';
import { GroundItemManager } from '../GroundItemManager.js';

describe('GroundItemManager', () => {
  it('adds items from a snapshot', () => {
    const m = new GroundItemManager();
    m.applySnapshot([{ id: 'a', typeId: 1, x: 10, y: 20 }]);
    expect(m.count()).toBe(1);
    expect(m.all()[0]).toMatchObject({ id: 'a', typeId: 1, x: 10, y: 20 });
  });

  it('removes items absent from the snapshot', () => {
    const m = new GroundItemManager();
    m.applySnapshot([{ id: 'a', typeId: 1, x: 0, y: 0 }, { id: 'b', typeId: 1, x: 0, y: 0 }]);
    m.applySnapshot([{ id: 'b', typeId: 1, x: 0, y: 0 }]);
    expect(m.has('a')).toBe(false);
    expect(m.count()).toBe(1);
  });

  it('updates position in place on re-snapshot', () => {
    const m = new GroundItemManager();
    m.applySnapshot([{ id: 'a', typeId: 1, x: 0, y: 0 }]);
    m.applySnapshot([{ id: 'a', typeId: 1, x: 5, y: 7 }]);
    expect(m.all()[0]).toMatchObject({ x: 5, y: 7 });
  });

  it('an empty snapshot clears everything', () => {
    const m = new GroundItemManager();
    m.applySnapshot([{ id: 'a', typeId: 1, x: 0, y: 0 }]);
    m.applySnapshot([]);
    expect(m.count()).toBe(0);
  });
});
