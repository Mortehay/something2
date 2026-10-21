import { describe, expect, it } from 'vitest';
import {
  filterSpriteSubjects, isSpritePageSelected, selectAllSpriteSubjects, setSpritePageSelected, spritePage,
  targetsForSprites, framesCap, cellCount, estimateLabel, defaultActionsFor, rowLabels,
  isBoxProp, propSways, actionHint,
} from '../spriteSelection.js';
import { PAGE_SIZE } from '../artSelection.js';

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


describe('sprite console paging', () => {
  const many = Array.from({ length: PAGE_SIZE * 2 + 5 }, (_, i) => ({ id: i + 1, name: `e${i + 1}` }));

  it('slices the requested page and counts pages', () => {
    const { page, pages, rows: shown } = spritePage(many, 2);
    expect([page, pages, shown.length]).toEqual([2, 3, PAGE_SIZE]);
    expect(shown[0].id).toBe(PAGE_SIZE + 1);
  });

  it('clamps a page past the end to the last page instead of showing nothing', () => {
    const { page, rows: shown } = spritePage(many.slice(0, 10), 3);
    expect(page).toBe(1);
    expect(shown.map((r) => r.id)).toEqual(many.slice(0, 10).map((r) => r.id));
  });

  it('has one empty page when nothing matches', () => {
    expect(spritePage([], 1)).toEqual({ page: 1, pages: 1, rows: [] });
  });

  it('selects and deselects only the rows on the page, keeping others', () => {
    const pageRows = spritePage(many, 1).rows;
    const outside = many[PAGE_SIZE + 3].id;
    const on = setSpritePageSelected(new Set([outside]), pageRows, true);
    expect(on.size).toBe(PAGE_SIZE + 1);
    expect(isSpritePageSelected(on, pageRows)).toBe(true);
    const off = setSpritePageSelected(on, pageRows, false);
    expect([...off]).toEqual([outside]);
    expect(isSpritePageSelected(off, pageRows)).toBe(false);
  });

  it('never reports an empty page as fully selected', () => {
    expect(isSpritePageSelected(new Set([1]), [])).toBe(false);
  });
});

describe('sprite console action controls', () => {
  const catalog = {
    max_frames: 8,
    actions: [{ id: 'idle', max_frames: 8 }, { id: 'sway', max_frames: 6 }, { id: 'attack', max_frames: 4 }],
  };

  it('framesCap uses the smallest selected max', () => {
    expect(framesCap(catalog, ['idle', 'attack'])).toBe(4);
    expect(framesCap(catalog, ['idle'])).toBe(8);
    expect(framesCap(catalog, [])).toBe(8);
  });

  it('cellCount: a prop is one edit (1 cell) whatever the actions and frames', () => {
    const creature = { is_creature: true };
    const prop = { is_creature: false };
    expect(cellCount([creature], ['idle', 'sway'], 4)).toBe(64);
    expect(cellCount([prop], ['idle', 'sway'], 4)).toBe(1);
    expect(cellCount([prop], ['idle'], 1)).toBe(1);
    expect(cellCount([creature, prop], ['idle'], 2)).toBe(17);
  });

  it('isBoxProp: a GPU-box object row without a sheet (Props v2)', () => {
    expect(isBoxProp({ backend: 'gpu-box', generation_kind: 'object', image_key: 'i.png' })).toBe(true);
    expect(isBoxProp({ backend: 'gpu-box', generation_kind: 'object', atlas_key: 'old-sheet.png' })).toBe(false);
    expect(isBoxProp({ backend: 'gpu-box', generation_kind: 'creature' })).toBe(false);
    expect(isBoxProp({ backend: 'local', generation_kind: 'object', image_key: 'i.png' })).toBe(false);
  });

  it('propSways follows the queued actions', () => {
    expect(propSways({ actions: ['idle', 'sway'] })).toBe(true);
    expect(propSways({ actions: ['idle'] })).toBe(false);
    expect(propSways({ actions: null })).toBe(false);
  });

  it('actionHint explains what sway means for props', () => {
    expect(actionHint('sway')).toBe('props: sway in the game (no sheet)');
    expect(actionHint('idle')).toBe(null);
  });

  it('estimateLabel formats 336 cells at 22 s', () => {
    expect(estimateLabel(336, 22)).toBe('336 cells · ~2 h 3 min');
    expect(estimateLabel(1, 22)).toBe('1 cell · < 1 min');
    expect(estimateLabel(10, 30)).toBe('10 cells · ~5 min');
  });

  describe('defaultActionsFor', () => {
    const prop = { is_creature: false, is_playable: false };
    const wolf = { is_creature: true };

    it('idle + sway when a flat prop is selected', () => {
      expect(defaultActionsFor(catalog, [wolf, prop])).toEqual(['idle', 'sway']);
    });

    it('idle only when only creatures are selected or nothing is', () => {
      expect(defaultActionsFor(catalog, [wolf])).toEqual(['idle']);
      expect(defaultActionsFor(catalog, [])).toEqual(['idle']);
    });

    it('keeps only ids the catalog has', () => {
      expect(defaultActionsFor({ actions: [{ id: 'sway' }, { id: 'walk' }] }, [prop])).toEqual(['sway']);
      expect(defaultActionsFor({ actions: [{ id: 'walk' }] }, [wolf])).toEqual([]);
      expect(defaultActionsFor(null, [prop])).toEqual([]);
    });
  });

  it('rowLabels formats each row', () => {
    const manifest = { rows: [
      { row: 0, action: 'idle', direction: 's', frames: 4 },
      { row: 1, action: 'walk', direction: 'se', frames: 6 },
    ] };
    expect(rowLabels(manifest)).toEqual(['row 0 · idle · s · 4 frames', 'row 1 · walk · se · 6 frames']);
  });

  it('rowLabels is empty for a legacy atlas without rows', () => {
    expect(rowLabels({ frames: {} })).toEqual([]);
    expect(rowLabels(null)).toEqual([]);
  });
});
