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
  // The exact list a player sees, pinned. SOMET-263's whole requirement is
  // "the player sees only the game view and a read-only world map", so an
  // extra entry appearing here is a requirement break, not a count to bump.
  it('shows a non-admin the game view and the player world map, and nothing else', () => {
    const items = allItems(visibleSections(false));
    expect(items.map((i) => i.path)).toEqual(['/game', '/game/map']);
  });

  it('never shows a non-admin an editor', () => {
    const items = allItems(visibleSections(false));
    // The player's map must be the read-only route, never the admin editor
    // that shares its label.
    expect(items.map((i) => i.path)).not.toContain('/game/world-map');
    expect(items.every((i) => !i.adminType)).toBe(true);
  });

  it('shows an admin the two player screens plus all eleven admin screens', () => {
    const items = allItems(visibleSections(true));
    expect(items).toHaveLength(13);
    expect(items.map((i) => i.path)).toEqual([
      '/game', '/game/map', '/game/tiles', '/game/entities', '/game/items',
      '/game/maps', '/game/biomes', '/game/creature-behaviors', '/game/vfx', '/game/world-map',
      // Regions from the remote world-spec generator, beside the map editors
      // because an admin opens it to look at content, not to configure a host.
      '/game/generated-worlds',
      // Progression epic T1: game_settings editor, plus the mount points the
      // affix (T12) and passive-node (T9) admin sections land in. It is NOT at
      // /game/settings -- that path is already AI Providers.
      '/game/admin/progression',
      // SOMET-330: AI Providers, last because it is configuration rather than
      // content -- opened once to point the game at a machine, not per session.
      '/game/settings',
    ]);
  });

  it('gives the two world-map entries distinct labels', () => {
    // Both are "World Map" to the person reading the sidebar. An admin sees
    // both at once, so the editor is the one that gets qualified.
    const labels = allItems(visibleSections(true))
      .filter((i) => i.path.includes('map')).map((i) => i.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('hides every admin-only section from a non-admin', () => {
    expect(visibleSections(false).some((s) => s.adminOnly)).toBe(false);
  });
});
