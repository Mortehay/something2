import { describe, it, expect } from 'vitest';
import { CreatureManager } from './CreatureManager.js';

describe('CreatureManager (render-only)', () => {
  it('applySnapshot adds, updates, and removes by id', () => {
    const m = new CreatureManager();
    m.applySnapshot([{ id: 'a', type: 'Wolf', x: 10, y: 10, facing: 'S', hp: 10, color: '#c0392b' }]);
    expect(m.count()).toBe(1);
    // update existing 'a' target + add 'b'
    m.applySnapshot([
      { id: 'a', type: 'Wolf', x: 20, y: 10, facing: 'E', hp: 9, color: '#c0392b' },
      { id: 'b', type: 'Wolf', x: 50, y: 50, facing: 'S', hp: 10, color: '#c0392b' },
    ]);
    expect(m.count()).toBe(2);
    const a = m.all().find((c) => c.id === 'a');
    expect(a.tx).toBe(20);        // new target
    expect(a.facing).toBe('E');
    // 'a' removed from snapshot → dropped
    m.applySnapshot([{ id: 'b', type: 'Wolf', x: 50, y: 50, facing: 'S', hp: 10, color: '#c0392b' }]);
    expect(m.has('a')).toBe(false);
    expect(m.count()).toBe(1);
  });

  it('interpolate moves x,y toward the target', () => {
    const m = new CreatureManager();
    m.applySnapshot([{ id: 'a', type: 'Wolf', x: 0, y: 0, facing: 'S', hp: 10, color: '#000' }]);
    m.applySnapshot([{ id: 'a', type: 'Wolf', x: 100, y: 0, facing: 'E', hp: 10, color: '#000' }]);
    const a = m.all()[0];
    expect(a.x).toBe(0);   // not yet interpolated
    m.interpolate(0.05);
    expect(a.x).toBeGreaterThan(0);
    expect(a.x).toBeLessThanOrEqual(100);
  });

  it('applySnapshot stores maxHp and mode for hp bars', () => {
    const m = new CreatureManager();
    m.applySnapshot([{ id: 'a', type: 'Wolf', x: 0, y: 0, facing: 'S', hp: 7, maxHp: 10, mode: 'chase', color: '#c00' }]);
    const a = m.all()[0];
    expect(a.hp).toBe(7);
    expect(a.maxHp).toBe(10);
    expect(a.mode).toBe('chase');
  });
});
