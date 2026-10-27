import { describe, expect, it } from 'vitest';
import { appearanceImageKey, appearanceVisual } from '../characterAppearance.js';

describe('character appearance visuals', () => {
  it('uses a stable class and variant image key', () => {
    expect(appearanceImageKey('Mage', 3)).toBe('player:mage:3');
  });

  it('falls back to the class image while a variant has no generated art', () => {
    const visual = appearanceVisual({
      name: 'Mage', image: 'sprites/Mage/seeded/static.png',
      appearances: [{ variant: 3, image: null, sprite: null }],
    }, 3);
    expect(visual).toEqual({
      className: 'Mage', variant: 3,
      image: 'sprites/Mage/seeded/static.png', sprite: null, renderMode: 'static',
    });
  });

  it('uses generated variant art when it exists', () => {
    const sprite = { atlas_key: 'sprites/characters/mage/3/atlas.png' };
    expect(appearanceVisual({
      name: 'Mage', image: 'class.png',
      appearances: [{ variant: 3, image: 'variant.png', sprite, renderMode: 'animated' }],
    }, 3)).toMatchObject({ image: 'variant.png', sprite, renderMode: 'animated' });
  });
});
