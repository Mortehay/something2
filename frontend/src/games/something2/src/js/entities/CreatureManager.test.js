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

  // --- status effects (Task 9) ---

  it('applySnapshot CLEARS a creature\'s effects when the server stops sending them', () => {
    // The server OMITS the effects field entirely once nothing is active
    // (activeEffectKeys returns null), so the common "effect ended" frame
    // carries no field at all. A `if (c.effects)` guard here — the natural
    // shape, and the one used for `color` two lines away — would leave the
    // chill ring burning on the creature forever. That is exactly the class of
    // bug that is invisible in a unit test of the renderer and only shows up
    // as a permanently-tinted mob in the browser.
    const m = new CreatureManager();
    m.applySnapshot([{ id: 'a', type: 'Slime', x: 10, y: 10, facing: 'S', hp: 10, maxHp: 10, effects: ['chill'] }]);
    expect(m.all()[0].effects).toEqual(['chill']);
    m.applySnapshot([{ id: 'a', type: 'Slime', x: 10, y: 10, facing: 'S', hp: 10, maxHp: 10 }]);
    expect(m.all()[0].effects).toBeNull();
  });

  it('applySnapshot keeps effects per-creature and carries them onto newly seen ones', () => {
    const m = new CreatureManager();
    m.applySnapshot([
      { id: 'a', type: 'Slime', x: 10, y: 10, facing: 'S', hp: 10, maxHp: 10, effects: ['burn', 'shock'] },
      { id: 'b', type: 'Wolf', x: 50, y: 50, facing: 'S', hp: 10, maxHp: 10 },
    ]);
    const byId = Object.fromEntries(m.all().map((c) => [c.id, c]));
    expect(byId.a.effects).toEqual(['burn', 'shock']);
    // The unaffected creature must not inherit the other's effects.
    expect(byId.b.effects).toBeNull();
  });
});
