import { describe, it, expect } from 'vitest';
import { NAV_SECTIONS, visibleSections } from '../navSections.js';

const allItems = (sections) => sections.flatMap((s) => s.items);

describe('NAV_SECTIONS', () => {
  it('gives every item an id, label, path and icon', () => {
    for (const item of allItems(NAV_SECTIONS)) {
      expect(item.id, `${item.label} id`).toBeTruthy();
      expect(item.label, `${item.id} label`).toBeTruthy();
      expect(item.path, `${item.id} path`).toMatch(/^\/game/);
      expect(typeof item.Icon, `${item.id} icon`).toBe('function');
    }
  });

  it('has no duplicate paths or ids', () => {
    const items = allItems(NAV_SECTIONS);
    expect(new Set(items.map((i) => i.path)).size).toBe(items.length);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });

  it('only uses admin colour keys the tab bar already defined', () => {
    for (const item of allItems(NAV_SECTIONS)) {
      if (item.adminType) expect(['entity', 'items', 'maps']).toContain(item.adminType);
    }
  });
});

describe('visibleSections', () => {
  it('shows a non-admin only the game view', () => {
    const items = allItems(visibleSections(false));
    expect(items.map((i) => i.path)).toEqual(['/game']);
  });

  it('shows an admin the game view plus all six admin screens', () => {
    const items = allItems(visibleSections(true));
    expect(items).toHaveLength(7);
    expect(items.map((i) => i.path)).toEqual([
      '/game', '/game/tiles', '/game/entities', '/game/items',
      '/game/maps', '/game/biomes', '/game/world-map',
    ]);
  });

  it('hides every admin-only section from a non-admin', () => {
    expect(visibleSections(false).some((s) => s.adminOnly)).toBe(false);
  });
});
