import { describe, it, expect } from 'vitest';
import { essentialArtKeys, nearbyCreatureArtKeys } from '../entryArt.js';

describe('essentialArtKeys', () => {
  const entityTypes = {
    Wolf: { isCreature: true, image: 'sprites/Wolf.png' },
    'Village Blacksmith': { isCreature: false, pointKind: 'blacksmith', image: 'sprites/smith.png' },
    pine: { isCreature: false, pointKind: null, image: 'sprites/pine.png' },
    waystone: { isCreature: false, pointKind: 'waypoint', image: null, sprite: { atlas_key: 'sprites/way.atlas.png' } },
    noart: { isCreature: false, pointKind: 'bank', image: '' },
  };
  const tileTypes = { grass: { image: 'tiles/grass.png' }, lava: { sprite: { atlas_key: 'tiles/lava.atlas.png' } }, bare: { color: '#000' } };

  it('puts the player first, then points, then tiles, then other scenery, and never creatures', () => {
    expect(essentialArtKeys({ tileTypes, entityTypes, playerKey: 'Mage_1', playerAtlas: 'sprites/mage.atlas.png' })).toEqual([
      'Mage_1', 'sprites/mage.atlas.png',
      'sprites/smith.png', 'sprites/way.atlas.png',
      'tiles/grass.png', 'tiles/lava.atlas.png',
      'sprites/pine.png',
    ]);
  });

  it('accepts tile types as an array and drops duplicates and missing catalogues', () => {
    expect(essentialArtKeys({ tileTypes: [{ image: 'a' }, { image: 'a' }, null], entityTypes: null, playerKey: null })).toEqual(['a']);
    expect(essentialArtKeys({})).toEqual([]);
  });
});

describe('nearbyCreatureArtKeys', () => {
  const entityTypes = {
    Wolf: { image: 'sprites/Wolf.png' }, Bear: { sprite: { atlas_key: 'sprites/Bear.atlas.png' } }, Far: { image: 'sprites/Far.png' },
  };
  const creature = (type, x, y) => ({ type, x, y });

  it('takes only creatures in range, once per type', () => {
    const creatures = [creature('Wolf', 10, 0), creature('Wolf', 20, 0), creature('Bear', 0, 90), creature('Far', 500, 0), creature('Ghost', 0, 0)];
    expect(nearbyCreatureArtKeys({ creatures, entityTypes, x: 0, y: 0, radius: 100 })).toEqual(['sprites/Wolf.png', 'sprites/Bear.atlas.png']);
  });

  it('with no snapshot yet there is nothing to wait for', () => {
    expect(nearbyCreatureArtKeys({ creatures: [], entityTypes, x: 0, y: 0, radius: 100 })).toEqual([]);
  });
});
