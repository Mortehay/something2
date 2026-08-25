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

  // SOMET-490: the grade rides the snapshot. The renderer reads it off THIS
  // store, so a manager that drops it makes the glow unreachable no matter
  // what the server sends.
  it('carries the rarity grade from the snapshot', () => {
    const m = new GroundItemManager();
    m.applySnapshot([{ id: 'a', typeId: 1, x: 0, y: 0, rarity: 'foxy' }]);
    expect(m.all()[0].rarity).toBe('foxy');
  });

  it('updates the grade on a re-snapshot, not only on first sight', () => {
    // The server re-sends every neighbourhood item on a fixed cadence, so an
    // item is created once and updated forever after. A rarity written only
    // in the create branch is right by accident today and wrong the moment a
    // re-read is the first frame to carry the grade -- which is exactly what
    // a chunk deactivate/reactivate cycle produces.
    const m = new GroundItemManager();
    m.applySnapshot([{ id: 'a', typeId: 1, x: 0, y: 0, rarity: 'white' }]);
    m.applySnapshot([{ id: 'a', typeId: 1, x: 0, y: 0, rarity: 'foxy' }]);
    expect(m.all()[0].rarity).toBe('foxy');
  });

  it('an empty snapshot clears everything', () => {
    const m = new GroundItemManager();
    m.applySnapshot([{ id: 'a', typeId: 1, x: 0, y: 0 }]);
    m.applySnapshot([]);
    expect(m.count()).toBe(0);
  });
});
