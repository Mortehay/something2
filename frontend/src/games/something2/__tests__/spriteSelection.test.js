import { describe, expect, it } from 'vitest';
import { filterSpriteSubjects, selectAllSpriteSubjects, targetsForSprites } from '../spriteSelection.js';

const rows = [
  { id: 1, name: 'Wolf', is_creature: true, render_mode: 'static', sprite: null, image: '' },
  { id: 2, name: 'pine_tree', is_creature: false, render_mode: 'static', image: 'tree.png' },
  { id: 3, name: 'Torch', is_creature: false, render_mode: 'animated', job_state: 'failed' },
];

describe('sprite console selection', () => {
  it('filters missing directional entities', () => {
    expect(filterSpriteSubjects(rows, { shape: 'directional', status: 'missing', search: '' })
      .map((row) => row.name)).toEqual(['Wolf']);
  });

  it('selects every row matching the current filter', () => {
    expect([...selectAllSpriteSubjects(filterSpriteSubjects(rows, {
      shape: 'flat', status: 'all', search: '',
    }))]).toEqual([2, 3]);
  });
});

describe('sprite console enqueue targets', () => {
  it('sends a plain entity row by its own id, with no variant', () => {
    expect(targetsForSprites([{ id: 1, name: 'Wolf', variant: null }]))
      .toEqual([{ entity_id: 1, variant: null }]);
  });

  it('sends an appearance-variant row by its class entity_id, not its synthetic id', () => {
    expect(targetsForSprites([{ id: '3:2', entity_id: 3, variant: 2, name: 'Mage — Appearance 2' }]))
      .toEqual([{ entity_id: 3, variant: 2 }]);
  });

  it('handles a mixed selection of both kinds', () => {
    expect(targetsForSprites([
      { id: 1, variant: null },
      { id: '3:2', entity_id: 3, variant: 2 },
    ])).toEqual([{ entity_id: 1, variant: null }, { entity_id: 3, variant: 2 }]);
  });
});

