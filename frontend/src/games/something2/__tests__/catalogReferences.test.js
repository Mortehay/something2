import { describe, it, expect } from 'vitest';
import { entityTypesReferencingTile, orphanedSpawnTiles } from '../catalogReferences.js';

// F-027/SOMET-207: confirmed live -- created an entity type with
// spawn_tiles:["auditfixturetile"], deleted that tile type via TileTypesAdmin
// (a bare window.confirm with no reference check), and the entity type's
// Spawn Tiles checklist silently omitted the now-dangling entry with no
// warning anywhere, even though GET /api/entity-types still returned it.

describe('entityTypesReferencingTile', () => {
  it('finds entity types whose spawn_tiles names the given tile', () => {
    const entityTypes = [
      { name: 'Cactus', spawn_tiles: ['sand', 'desert'] },
      { name: 'Wolf', spawn_tiles: ['grass'] },
    ];
    expect(entityTypesReferencingTile('sand', entityTypes)).toEqual(['Cactus']);
  });

  it('returns an empty list when nothing references the tile', () => {
    const entityTypes = [{ name: 'Wolf', spawn_tiles: ['grass'] }];
    expect(entityTypesReferencingTile('lava', entityTypes)).toEqual([]);
  });

  it('handles a missing/undefined entityTypes list without throwing', () => {
    expect(entityTypesReferencingTile('sand', undefined)).toEqual([]);
  });
});

describe('orphanedSpawnTiles', () => {
  it('flags a spawn_tiles entry whose tile type no longer exists', () => {
    const spawnTiles = ['sand', 'grass'];
    const tileTypes = [{ name: 'grass' }];
    expect(orphanedSpawnTiles(spawnTiles, tileTypes)).toEqual(['sand']);
  });

  it('returns an empty list when every spawn tile still exists', () => {
    const spawnTiles = ['grass'];
    const tileTypes = [{ name: 'grass' }, { name: 'sand' }];
    expect(orphanedSpawnTiles(spawnTiles, tileTypes)).toEqual([]);
  });
});
