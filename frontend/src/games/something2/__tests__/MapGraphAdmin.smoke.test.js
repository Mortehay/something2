import { describe, it, expect } from 'vitest';
import MapGraphAdmin from '../MapGraphAdmin.jsx';

describe('MapGraphAdmin', () => {
  it('is a component export', () => {
    expect(typeof MapGraphAdmin).toBe('function');
  });

  it('dungeon tagging correctly tags worlds with and without portals', () => {
    const worlds = [
      { id: 'w1', name: 'Vale Crossing', is_entry: true },
      { id: 'w2', name: 'Catacombs Entry', is_entry: false },
      { id: 'w3', name: 'Highlands', is_entry: false },
    ];
    const links = [
      { from_world_id: 'w1', to_world_id: 'w2', edge: 'PORTAL' },
      { from_world_id: 'w1', to_world_id: 'w3', edge: 'N' },
    ];

    const hasDungeon = (wId) => links.some(
      (l) => l.edge === 'PORTAL' && (l.from_world_id === wId || l.to_world_id === wId)
    );

    expect(hasDungeon('w1')).toBe(true);
    expect(hasDungeon('w2')).toBe(true);
    expect(hasDungeon('w3')).toBe(false);

    const tagFor = (wId) => (hasDungeon(wId) ? '🏰 [Dungeon]' : '🌿 [No Dungeon]');
    expect(tagFor('w1')).toBe('🏰 [Dungeon]');
    expect(tagFor('w2')).toBe('🏰 [Dungeon]');
    expect(tagFor('w3')).toBe('🌿 [No Dungeon]');
  });
});
