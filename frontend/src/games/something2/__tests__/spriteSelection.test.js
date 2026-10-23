process.env.TZ = 'UTC';
import { describe, expect, it } from 'vitest';
import {
  filterSpriteSubjects, isSpritePageSelected, selectAllSpriteSubjects, setSpritePageSelected, spritePage,
  targetsForSprites, framesCap, cellCount, estimateLabel, defaultActionsFor, rowLabels,
  isBoxProp, PROP_FX_OPTIONS, propFxLabel, propEffect, selectionKinds, queueButtonLabel, queuePayload, conceptImageOf, sheetImageOf, sheetManifestOf, jobStateLabel, conceptLabelOf, lastUpdateLabel, deleteConfirmText,
  isPropSubject, nextConceptCaption, newConceptConfirmText,
  batchProgress, currentProgressLabel, rowProgressLabel, queueIsLive, runJustEnded,
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
    expect(isBoxProp({ backend: 'gpu-box', generation_kind: 'creature', is_creature: true })).toBe(false);
    expect(isBoxProp({ backend: 'local', generation_kind: 'object', image_key: 'i.png' })).toBe(false);
  });

  // Props v2: a prop's in-game idle effect is chosen explicitly (prop_fx),
  // not derived from the action checkboxes.
  it('PROP_FX_OPTIONS / propFxLabel: None (default), Sway, Shine', () => {
    expect(PROP_FX_OPTIONS.map((o) => [o.id, o.label])).toEqual([['none', 'None'], ['sway', 'Sway'], ['shine', 'Shine']]);
    expect(propFxLabel('shine')).toBe('Shine');
    expect(propFxLabel('sway')).toBe('Sway');
    expect(propFxLabel('none')).toBe('None');
    expect(propFxLabel(undefined)).toBe('None');
  });

  it('propEffect reads the row prop_fx, never the actions', () => {
    expect(propEffect({ prop_fx: 'shine', actions: ['idle'] })).toBe('shine');
    expect(propEffect({ prop_fx: 'sway' })).toBe('sway');
    expect(propEffect({ prop_fx: null, actions: ['idle', 'sway'] })).toBe('none');
    expect(propEffect({ prop_fx: 'glow' })).toBe('none');
    expect(propEffect(null)).toBe('none');
  });

  it('selectionKinds tells props and creatures apart', () => {
    const wolf = { is_creature: true };
    const prop = { is_creature: false };
    expect(selectionKinds([wolf, prop])).toEqual({ props: true, creatures: true, propsOnly: false });
    expect(selectionKinds([prop])).toEqual({ props: true, creatures: false, propsOnly: true });
    expect(selectionKinds([wolf])).toEqual({ props: false, creatures: true, propsOnly: false });
    expect(selectionKinds([])).toEqual({ props: false, creatures: false, propsOnly: false });
  });

  describe('queueButtonLabel', () => {
    const fresh = { id: 1 };
    const done = { id: 2, job_state: 'done' };
    const queued = { id: 3, job_state: 'queued' };
    const running = { id: 4, job_state: 'running' };

    it('says queue for rows without a live job, finished ones included', () => {
      expect(queueButtonLabel([fresh, done])).toEqual({ label: 'Queue 2 selected', actionable: true });
    });
    it('says update when every row is already queued', () => {
      expect(queueButtonLabel([queued])).toEqual({ label: 'Update 1 queued', actionable: true });
    });
    it('counts both when the selection mixes new and queued rows', () => {
      expect(queueButtonLabel([fresh, queued, queued]).label).toBe('Queue 1 · update 2');
    });
    it('names running rows as unchanged and is inert when only they are selected', () => {
      expect(queueButtonLabel([queued, running]).label).toBe('Update 1 queued · 1 running, unchanged');
      expect(queueButtonLabel([running])).toEqual({ label: '1 running, unchanged', actionable: false });
      expect(queueButtonLabel([])).toEqual({ label: 'Queue 0 selected', actionable: false });
    });
  });

  describe('queuePayload', () => {
    const wolf = { id: 4, is_creature: true, variant: null };
    const prop = { id: 12, is_creature: false, variant: null };

    it('creatures only: the chosen actions and frames, no prop_fx', () => {
      expect(queuePayload(catalog, [wolf], { actions: ['idle', 'attack'], frames: 3, propFx: 'shine' })).toEqual({
        targets: [{ entity_id: 4, variant: null }], actions: ['idle', 'attack'], frames: 3,
      });
    });

    it('props only: actions/frames do not apply (idle x1 placeholder) and prop_fx is sent', () => {
      expect(queuePayload(catalog, [prop], { actions: [], frames: 6, propFx: 'shine' })).toEqual({
        targets: [{ entity_id: 12, variant: null }], actions: ['idle'], frames: 1, prop_fx: 'shine',
      });
    });

    it('mixed: creature actions/frames plus prop_fx (default none)', () => {
      expect(queuePayload(catalog, [wolf, prop], { actions: ['idle'], frames: 4 })).toEqual({
        targets: [{ entity_id: 4, variant: null }, { entity_id: 12, variant: null }],
        actions: ['idle'], frames: 4, prop_fx: 'none',
      });
    });
  });

  it('estimateLabel formats 336 cells at 22 s', () => {
    expect(estimateLabel(336, 22)).toBe('336 cells · ~2 h 3 min');
    expect(estimateLabel(1, 22)).toBe('1 cell · < 1 min');
    expect(estimateLabel(10, 30)).toBe('10 cells · ~5 min');
  });

  describe('defaultActionsFor', () => {
    const prop = { is_creature: false, is_playable: false };
    const wolf = { is_creature: true };

    it('idle only, even when a flat prop is selected (props do not use actions)', () => {
      expect(defaultActionsFor(catalog, [wolf, prop])).toEqual(['idle']);
      expect(defaultActionsFor(catalog, [prop])).toEqual(['idle']);
    });

    it('idle only when only creatures are selected or nothing is', () => {
      expect(defaultActionsFor(catalog, [wolf])).toEqual(['idle']);
      expect(defaultActionsFor(catalog, [])).toEqual(['idle']);
    });

    it('keeps only ids the catalog has', () => {
      expect(defaultActionsFor({ actions: [{ id: 'sway' }, { id: 'walk' }] }, [prop])).toEqual([]);
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

describe('conceptImageOf', () => {
  it('a prop prefers the generated concept, else appearance art, else the entity art', () => {
    const prop = { generation_kind: 'object' };
    expect(conceptImageOf({ ...prop, concept_key: 'c.png', appearance_image: 'a.png' })).toBe('c.png');
    expect(conceptImageOf({ ...prop, appearance_image: 'a.png', image: 'art.png' })).toBe('a.png');
    expect(conceptImageOf({ ...prop, image: 'art.png' })).toBe('art.png');
    expect(conceptImageOf({ ...prop })).toBe(null);
    expect(conceptImageOf({ backend: 'gpu-box', generation_kind: 'object', image: 'art.png' })).toBe('art.png');
  });
  it('a creature uses its job concept, else the kept concept, else nothing', () => {
    const c = { generation_kind: 'creature', is_creature: true, image: 'art.png', appearance_image: 'a.png' };
    expect(conceptImageOf({ ...c, concept_key: 'j.png', kept_concept_key: 'k.png' })).toBe('j.png');
    expect(conceptImageOf({ ...c, kept_concept_key: 'k.png' })).toBe('k.png');
    expect(conceptImageOf({ ...c })).toBe(null);
  });
});

describe('sheetImageOf', () => {
  it('is only something a sprite job produced or an approved sprite sheet -- never the plain entity art', () => {
    expect(sheetImageOf({ image: 'art.png' })).toBe(null);
    expect(sheetImageOf({ atlas_key: 'sheet.png', image: 'art.png' })).toBe('sheet.png');
    expect(sheetImageOf({ image_key: 'result.png', image: 'art.png' })).toBe('result.png');
    expect(sheetImageOf({ sprite: { atlas_key: 'approved.png' }, image: 'art.png' })).toBe('approved.png');
    expect(sheetImageOf({})).toBe(null);
  });
});

describe('conceptLabelOf', () => {
  it('a creature: used, reused, or a new one will be drawn', () => {
    const c = { generation_kind: 'creature', is_creature: true };
    expect(conceptLabelOf({ ...c, concept_key: 'j.png', kept_concept_key: 'k.png' })).toBe('Used concept');
    expect(conceptLabelOf({ ...c, kept_concept_key: 'k.png' })).toBe('Concept — reused');
    expect(conceptLabelOf({ ...c })).toBe('New concept will be drawn');
  });
  it('a prop keeps its labels', () => {
    const prop = { generation_kind: 'object' };
    expect(conceptLabelOf({ ...prop, concept_key: 'c.png', image: 'a.png' })).toBe('Used image');
    expect(conceptLabelOf({ ...prop, appearance_image: 'a.png' })).toBe('Appearance art');
    expect(conceptLabelOf({ ...prop, image: 'a.png' })).toBe('Current art');
    expect(conceptLabelOf({ ...prop })).toBe('Used image');
  });
});

describe('nextConceptCaption', () => {
  const c = { generation_kind: 'creature', is_creature: true };
  it('a creature: what the NEXT run uses', () => {
    expect(nextConceptCaption({ ...c, kept_concept_key: 'k.png' })).toBe('Concept — reused');
    expect(nextConceptCaption({ ...c, concept_key: 'j.png', kept_concept_key: 'k.png' })).toBe('Concept — reused');
    expect(nextConceptCaption({ ...c, concept_key: 'j.png' })).toBe('New concept will be drawn');
    expect(nextConceptCaption({ ...c })).toBe('New concept will be drawn');
  });
  it('a prop: its image label', () => {
    expect(nextConceptCaption({ generation_kind: 'object', image: 'a.png' })).toBe('Current art');
  });
});

describe('newConceptConfirmText', () => {
  it('names the count, singular for one', () => {
    expect(newConceptConfirmText(1)).toBe('Forget the kept concept for 1 subject? The next run draws a new one.');
    expect(newConceptConfirmText(3)).toBe('Forget the kept concept for 3 subjects? The next run draws a new one.');
  });
});

describe('isPropSubject', () => {
  it('generation_kind decides when present, over a stale shape', () => {
    expect(isPropSubject({ generation_kind: 'creature', is_creature: false, is_playable: false })).toBe(false);
    expect(isPropSubject({ generation_kind: 'object', is_creature: true })).toBe(true);
  });
  it('falls back to the shape when absent', () => {
    expect(isPropSubject({ is_creature: false, is_playable: false })).toBe(true);
    expect(isPropSubject({ is_creature: true })).toBe(false);
  });
});

describe('never-queued flat prop', () => {
  it('keeps its current image and label with no generation_kind', () => {
    const p = { is_creature: false, is_playable: false, image: 'x.png' };
    expect(conceptImageOf(p)).toBe('x.png');
    expect(conceptLabelOf(p)).toBe('Current art');
  });
});

describe('lastUpdateLabel', () => {
  it('spells September as Sep', () => {
    expect(lastUpdateLabel('2026-09-03T14:05:00Z').text).toBe('3 Sep 14:05');
  });
  it('formats local D Mon HH:MM with the ISO as title', () => {
    expect(lastUpdateLabel('2026-10-23T01:12:00.000Z')).toEqual({ text: '23 Oct 01:12', title: '2026-10-23T01:12:00.000Z' });
  });
  it('is a dash for none or garbage', () => {
    expect(lastUpdateLabel(null)).toEqual({ text: '—', title: '' });
    expect(lastUpdateLabel('nope')).toEqual({ text: '—', title: '' });
  });
});

describe('deleteConfirmText', () => {
  it('is the verbatim confirm copy, singular for one', () => {
    expect(deleteConfirmText(1)).toBe('Delete all generated sprites for 1 subject? Sheets, redraws and queued jobs are removed; concepts are kept. This cannot be undone.');
    expect(deleteConfirmText(3)).toBe('Delete all generated sprites for 3 subjects? Sheets, redraws and queued jobs are removed; concepts are kept. This cannot be undone.');
  });
});

describe('sprite batch progress (SOMET-662)', () => {
  const run = {
    running: true, totalCells: 4368, doneCells: 500, secondsPerCell: 50,
    current: { id: 'r1', phase: 'running', pct: 20, message: 'cell 3/16', cells: 150 },
  };

  it('weights the running row into the batch percentage and counts', () => {
    const p = batchProgress(run);
    expect(p.doneCells).toBe(530);
    expect(p.totalCells).toBe(4368);
    expect(p.pct).toBe(12);
    // (4368 - 530) * 50 s = 53.3 h
    expect(p.leftLabel).toBe('~53 h left');
  });

  it('formats short remainders and tolerates no run', () => {
    expect(batchProgress({ totalCells: 10, doneCells: 8, secondsPerCell: 30, current: null }).leftLabel).toBe('~1 min left');
    expect(batchProgress({ totalCells: 10, doneCells: 10, secondsPerCell: 30, current: null }).leftLabel).toBe('< 1 min left');
    expect(batchProgress({ totalCells: 600, doneCells: 100, secondsPerCell: 10, current: null }).leftLabel).toBe('~1 h 23 min left');
    expect(batchProgress(null)).toEqual({ pct: 0, doneCells: 0, totalCells: 0, leftLabel: '' });
    expect(batchProgress({ running: true, totalCells: 0, doneCells: 0 }).pct).toBe(0);
  });

  it('labels the current row by phase', () => {
    expect(currentProgressLabel(run)).toBe('20% · cell 3/16');
    expect(currentProgressLabel({ current: { phase: 'concept', pct: 0, cells: 4 } })).toBe('making concept…');
    expect(currentProgressLabel({ current: { phase: 'queued', pct: 0, cells: 4 } })).toBe("waiting in the box's queue");
    expect(currentProgressLabel({ current: { phase: 'storing', pct: 100, cells: 4 } })).toBe('storing…');
    expect(currentProgressLabel({ current: { phase: 'running', pct: 5, message: '', cells: 4 } })).toBe('5%');
    expect(currentProgressLabel(null)).toBe('');
  });

  it('shows a percentage only on the running row', () => {
    expect(rowProgressLabel({ job_id: 'r1', job_state: 'running' }, run)).toBe('running 20%');
    expect(rowProgressLabel({ job_id: 'r2', job_state: 'running' }, run)).toBeNull();
    expect(rowProgressLabel({ job_id: 'r1', job_state: 'queued' }, run)).toBeNull();
    expect(rowProgressLabel({ job_id: 'r1', job_state: 'running' }, { current: { id: 'r1', phase: 'concept', pct: 0 } })).toBeNull();
  });

  it('a running redraw row reads "redrawing N%"', () => {
    expect(rowProgressLabel({ job_id: 'r1', job_state: 'running', redraw_of: 'r0' }, run)).toBe('redrawing 20%');
  });
});

describe('sheet payload keys (frame redraw)', () => {
  it('sheetImageOf prefers atlas_key then sheet_atlas_key', () => {
    expect(sheetImageOf({ atlas_key: 'a.png', sheet_atlas_key: 'b.png' })).toBe('a.png');
    expect(sheetImageOf({ sheet_atlas_key: 'b.png' })).toBe('b.png');
    // gpu-box prop: newest row has image_key and no atlas; an older sheet row must not win
    expect(sheetImageOf({ image_key: 'c.png', sheet_atlas_key: 'b.png' })).toBe('c.png');
  });
  it('sheetManifestOf', () => {
    expect(sheetManifestOf({ manifest_key: 'm', sheet_manifest_key: 'n' })).toBe('m');
    expect(sheetManifestOf({ sheet_manifest_key: 'n' })).toBe('n');
    expect(sheetManifestOf({})).toBe(null);
  });
  it('jobStateLabel', () => {
    const r = (job_state) => ({ redraw_of: 5, job_state });
    expect(jobStateLabel(r('queued'))).toBe('redraw queued');
    expect(jobStateLabel(r('running'))).toBe('redrawing');
    expect(jobStateLabel(r('done'))).toBe('ready for review');
    expect(jobStateLabel(r('failed'))).toBe('redraw failed');
    expect(jobStateLabel({ job_state: 'running' })).toBe('running');
    expect(jobStateLabel({})).toBe('not queued');
  });
});

describe('run end refreshes the subjects list', () => {
  it('queueIsLive: a running batch or any queued/running row', () => {
    expect(queueIsLive({ run: { running: true }, stats: {} })).toBe(true);
    expect(queueIsLive({ run: null, stats: { queued: 2 } })).toBe(true);
    expect(queueIsLive({ run: null, stats: { running: 1 } })).toBe(true);
    expect(queueIsLive({ run: { running: false }, stats: { queued: 0, running: 0 } })).toBe(false);
    expect(queueIsLive({})).toBe(false);
  });
  it('runJustEnded fires only on live -> idle', () => {
    expect(runJustEnded(true, false)).toBe(true);
    expect(runJustEnded(false, false)).toBe(false);
    expect(runJustEnded(false, true)).toBe(false);
    expect(runJustEnded(true, true)).toBe(false);
    expect(runJustEnded(undefined, false)).toBe(false);
  });
});
