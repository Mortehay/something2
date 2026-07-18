import { describe, it, expect } from 'vitest';
import { ProjectileManager } from '../ProjectileManager.js';

it('applySnapshot adds, updates, and drops projectiles by id', () => {
  const m = new ProjectileManager();
  m.applySnapshot([{ id: '1', x: 0, y: 0, element: null }, { id: '2', x: 5, y: 5, element: 'arcane' }]);
  expect(m.all().map((p) => p.id).sort()).toEqual(['1', '2']);
  m.applySnapshot([{ id: '2', x: 9, y: 9, element: 'arcane' }]); // 1 gone, 2 moved
  const ids = m.all().map((p) => p.id);
  expect(ids).toEqual(['2']);
});

it('interpolate moves the render position toward the latest target', () => {
  const m = new ProjectileManager();
  m.applySnapshot([{ id: '1', x: 0, y: 0, element: null }]);
  m.applySnapshot([{ id: '1', x: 100, y: 0, element: null }]); // new target
  m.interpolate(1); // advance
  const p = m.all()[0];
  expect(p.x).toBeGreaterThan(0);
  expect(p.x).toBeLessThanOrEqual(100);
});
