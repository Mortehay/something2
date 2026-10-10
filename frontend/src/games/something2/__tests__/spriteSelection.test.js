import { describe, expect, it } from 'vitest';
import { filterSpriteSubjects, selectAllSpriteSubjects } from '../spriteSelection.js';

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

