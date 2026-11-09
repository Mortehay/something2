process.env.TZ = 'UTC';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  nextSpriteSort, sortSpriteSubjects, columnFilterChoices, actionTokens, backendTokens, directionTokens,
  filterSpriteSubjects, isSpritePageSelected, selectAllSpriteSubjects, setSpritePageSelected, spritePage,
  targetsForSprites, framesCap, cellCount, estimateLabel, ESTIMATE_REUSE_HINT, WEST_MIRROR_HINT, defaultActionsFor, rowLabels,
  isBoxProp, PROP_FX_OPTIONS, propFxLabel, propEffect, selectionKinds, queueButtonLabel, queuePayload, conceptImageOf, sheetImageOf, sheetManifestOf, jobStateLabel, conceptLabelOf, lastUpdateLabel, deleteConfirmText,
  isPropSubject, nextConceptCaption, newConceptConfirmText, newCreatureBody, newCreatureError,
  batchProgress, batchHeadline, currentProgressLabel, rowProgressLabel, queueIsLive, runJustEnded,
  SPRITE_DIRECTIONS, DIRECTION_PRESETS, toggleDirection, presetOf, hasWestern, directionsLabel, queueBlockReason,
  boxCancelLines, startBatchWarning, forceConfirmText, refusedLines, SPRITE_CELLS, DEFAULT_CELL, cellInfoLabel, directionLossLines, spriteShape, methodOptionLabel, tookLabel, selectionCells, waitLabel,
} from '../spriteSelection.js';
import { PAGE_SIZE } from '../artSelection.js';
import { NEW_ENTITY_DEFAULTS } from '../newEntityDefaults.js';

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
    // 3 facings (s, e, n -- SOMET-669) x 2 actions x 4 frames.
    expect(cellCount([creature], ['idle', 'sway'], 4)).toBe(24);
    expect(cellCount([prop], ['idle', 'sway'], 4)).toBe(1);
    expect(cellCount([prop], ['idle'], 1)).toBe(1);
    expect(cellCount([creature, prop], ['idle'], 2)).toBe(7);
  });

  it('isBoxProp: a GPU-box object row without a sheet (Props v2)', () => {
    expect(isBoxProp({ backend: 'gpu-box', generation_kind: 'object', image_key: 'i.png' })).toBe(true);
    expect(isBoxProp({ backend: 'gpu-box', generation_kind: 'object', atlas_key: 'old-sheet.png' })).toBe(false);
    expect(isBoxProp({ backend: 'gpu-box', generation_kind: 'creature', is_creature: true })).toBe(false);
    expect(isBoxProp({ backend: 'local', generation_kind: 'object', image_key: 'i.png' })).toBe(false);
  });

  // Props v2: a prop's in-game idle effect is chosen explicitly (prop_fx),
  // not derived from the action checkboxes.
  it('PROP_FX_OPTIONS / propFxLabel: None (default), Sway, Shine, Drift', () => {
    expect(PROP_FX_OPTIONS.map((o) => [o.id, o.label])).toEqual([['none', 'None'], ['sway', 'Sway'], ['shine', 'Shine'], ['drift', 'Drift']]);
    expect(propFxLabel('drift')).toBe('Drift');
    expect(propEffect({ prop_fx: 'drift' })).toBe('drift');
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

    it('omits directions when the list is empty or absent (SOMET-700)', () => {
      expect(queuePayload(catalog, [wolf], { actions: ['idle'], frames: 3, directions: [] })).not.toHaveProperty('directions');
      expect(queuePayload(catalog, [wolf], { actions: ['idle'], frames: 3, directions: ['s'] }).directions).toEqual(['s']);
    });

    it('mixed: an unchosen effect is omitted, so the server decides per prop (SOMET-677)', () => {
      expect(queuePayload(catalog, [wolf, prop], { actions: ['idle'], frames: 4 })).toEqual({
        targets: [{ entity_id: 4, variant: null }, { entity_id: 12, variant: null }],
        actions: ['idle'], frames: 4,
      });
      expect(queuePayload(catalog, [wolf, prop], { actions: ['idle'], frames: 4, propFx: '' })).not.toHaveProperty('prop_fx');
    });

    it('mixed: a chosen effect travels, whatever the prop', () => {
      expect(queuePayload(catalog, [wolf, prop], { actions: ['idle'], frames: 4, propFx: 'drift' }).prop_fx).toBe('drift');
    });
  });

  // Source gate on the JSX (the suite has no DOM): the hint must actually be shown.
  it('SpriteConsoleAdmin renders ESTIMATE_REUSE_HINT next to the estimate', () => {
    const src = readFileSync(path.resolve(__dirname, '../SpriteConsoleAdmin.jsx'), 'utf8');
    expect(src).toMatch(/<Hint>\{ESTIMATE_REUSE_HINT\}<\/Hint>/);
    expect(ESTIMATE_REUSE_HINT).toMatch(/reused/);
  });

  it('offers the two cell sizes, 96x128 by default, and the Cell size select is rendered (SOMET-706)', () => {
    expect(SPRITE_CELLS.map((c) => c.id)).toEqual(['48x64', '96x128']);
    expect(SPRITE_CELLS.map((c) => c.label)).toEqual(['48×64', '96×128 (more detail)']);
    expect(DEFAULT_CELL).toBe('96x128');
    const src = readFileSync(path.resolve(__dirname, '../SpriteConsoleAdmin.jsx'), 'utf8');
    expect(src).toMatch(/Cell size\s*<select value=\{cellSize\}/);
    expect(src).toMatch(/SPRITE_CELLS\.map\(\(option\)/);
    expect(src).toMatch(/cell: cellSize/);
  });

  it('shows the cell in the sheet info only when it is not the 96x128 default', () => {
    expect(cellInfoLabel({ cell: '48x64' })).toBe('48×64');
    expect(cellInfoLabel({ cell: null })).toBeNull();
    expect(cellInfoLabel({ cell: null, atlas_key: 'a.png' })).toBe('48×64');
    expect(cellInfoLabel({ cell: null, job_id: 7 })).toBe('48×64');
    expect(cellInfoLabel({ cell: '96x128' })).toBeNull();
    expect(cellInfoLabel({})).toBeNull();
  });

  it('DirectionsField renders WEST_MIRROR_HINT under the direction presets and checkboxes', () => {
    const src = readFileSync(path.resolve(__dirname, '../SpriteConsoleAdmin.jsx'), 'utf8');
    const field = src.slice(src.indexOf('export function DirectionsField'), src.indexOf('export function SpriteTable'));
    expect(field).toMatch(/<Hint>\{WEST_MIRROR_HINT\}<\/Hint>/);
    expect(field.indexOf('WEST_MIRROR_HINT')).toBeGreaterThan(field.indexOf('SPRITE_DIRECTIONS.map'));
    expect(WEST_MIRROR_HINT).toBe('west rows (w, nw, sw) are mirrors of the east rows on this box');
  });

  it('estimateLabel formats 336 cells at 22 s', () => {
    expect(estimateLabel(336, 22)).toBe('336 cells · ~2 h 3 min');
    expect(estimateLabel(1, 22)).toBe('1 cell · < 1 min');
    expect(estimateLabel(10, 30)).toBe('10 cells · ~5 min');
  });

  describe('defaultActionsFor', () => {
    const prop = { is_creature: false, is_playable: false };
    const wolf = { is_creature: true };

    const ALL = ['idle', 'walk', 'attack', 'cast', 'damage', 'death', 'use'];
    const full = { actions: [...ALL, 'sway'].map((id) => ({ id })) };

    it('default actions are the seven creature actions filtered to the catalog', () => {
      expect(defaultActionsFor(full, [wolf])).toEqual(ALL);
      expect(defaultActionsFor(full, [])).toEqual(ALL);
      expect(defaultActionsFor({ actions: [{ id: 'idle' }, { id: 'walk' }, { id: 'use' }] }, [wolf])).toEqual(['idle', 'walk', 'use']);
    });

    it('props-only selection keeps idle', () => {
      expect(defaultActionsFor(full, [prop])).toEqual(['idle']);
      expect(defaultActionsFor(full, [wolf, prop])).toEqual(ALL);
    });

    it('keeps only ids the catalog has', () => {
      expect(defaultActionsFor({ actions: [{ id: 'sway' }, { id: 'walk' }] }, [prop])).toEqual([]);
      expect(defaultActionsFor({ actions: [{ id: 'sway' }] }, [wolf])).toEqual([]);
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

  it('counts the running row at its own (preset) rate, not the Fast history rate', () => {
    // 48-cell guided row at 8%: 44.16 cells x 117 s = ~1 h 26 min, not 44 x 40 s = 29 min.
    const p = batchProgress({
      totalCells: 48, doneCells: 0, secondsPerCell: 40,
      current: { id: 'r1', phase: 'running', pct: 8, cells: 48, secondsPerCell: 117 },
    });
    expect(p.leftLabel).toBe('~1 h 26 min left');
  });

  it('counts the running row by its predicted seconds left: 50% shows half', () => {
    // 700 s prediction at 50% = 350 s -> 6 min; cells x rate (10 x 100 x 0.5 = 500 s) is ignored
    const p = batchProgress({
      totalCells: 10, doneCells: 0, secondsPerCell: 40,
      current: { id: 'r1', phase: 'running', pct: 50, cells: 10, secondsPerCell: 100, predictedSeconds: 700 },
    });
    expect(p.leftLabel).toBe('~6 min left');
  });

  it('adds the queued rows at their own rates when the run reports queuedSeconds', () => {
    // running: 5 cells left x 100 s = 500 s; queued rows: 7200 s (their presets)
    const p = batchProgress({
      totalCells: 100, doneCells: 0, secondsPerCell: 40, queuedSeconds: 7200,
      current: { id: 'r1', phase: 'running', pct: 50, cells: 10, secondsPerCell: 100 },
    });
    expect(p.leftLabel).toBe('~2 h 8 min left');
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

describe('sprite direction selection', () => {
  const wolf = { id: 1, name: 'Wolf', is_creature: true };
  const torch = { id: 3, name: 'Torch', is_creature: false, generation_kind: 'object' };
  const catalog = { actions: [{ id: 'idle', max_frames: 8 }] };

  it('toggleDirection keeps compass order', () => {
    expect(toggleDirection(['s', 'e', 'n'], 'w')).toEqual(['s', 'e', 'n', 'w']);
    expect(toggleDirection(['s', 'e'], 's')).toEqual(['e']);
    expect(toggleDirection(['s', 'n'], 'e')).toEqual(['s', 'e', 'n']);
  });
  it('presetOf names the three presets, else null', () => {
    expect(presetOf(['s', 'e'])).toBe(2);
    expect(presetOf(['s', 'e', 'n', 'w'])).toBe(4);
    expect(presetOf(SPRITE_DIRECTIONS)).toBe(8);
    expect(presetOf(['s', 'e', 'n'])).toBeNull();
    expect(DIRECTION_PRESETS[8]).toEqual(SPRITE_DIRECTIONS);
  });
  it('hasWestern flags w, nw and sw', () => {
    expect(hasWestern(['s', 'w'])).toBe(true);
    expect(hasWestern(['s', 'e', 'n'])).toBe(false);
  });
  it('cellCount multiplies by the chosen directions, defaulting to 3', () => {
    expect(cellCount([wolf], ['idle', 'walk'], 3, DIRECTION_PRESETS[8])).toBe(48);
    expect(cellCount([wolf], ['idle', 'walk'], 3)).toBe(18);
    expect(cellCount([torch], ['idle', 'walk'], 3, DIRECTION_PRESETS[8])).toBe(1);
  });
  it('queuePayload sends directions for creatures, never for props-only', () => {
    const body = queuePayload(catalog, [wolf], { actions: ['idle'], frames: 2, directions: ['s', 'e'] });
    expect(body.directions).toEqual(['s', 'e']);
    const props = queuePayload(catalog, [torch], { actions: ['idle'], frames: 2, directions: ['s', 'e'] });
    expect('directions' in props).toBe(false);
  });
  it('directionsLabel', () => {
    expect(directionsLabel({ directions: ['s', 'e', 'n', 'w'], real_western: true })).toBe('s · e · n · w');
    expect(directionsLabel({ directions: ['s', 'e'] })).toBe('s · e');
    expect(directionsLabel({})).toBe('—');
  });
  it('queueBlockReason demands a direction only when a creature is selected', () => {
    expect(queueBlockReason([wolf], [])).toBe('Pick at least one direction');
    expect(queueBlockReason([torch], [])).toBeNull();
    expect(queueBlockReason([wolf], ['s'])).toBeNull();
  });
});

describe('box cancel helpers (SOMET-695)', () => {
  const stopping = { id: 1, subject: 'Mage:1', state: 'stopping', last_progress: 'cell 171/205' };
  const drawing = { id: 2, subject: 'Warrior:2', state: 'still_drawing', last_progress: 'cell 176/205' };
  it('a stopping row reads Stopping on the GPU box and has no retry', () => {
    expect(boxCancelLines([stopping])).toEqual([
      { id: 1, text: 'Stopping on the GPU box… (cell 171/205)', retry: false },
    ]);
  });
  it('a still_drawing row says the box ignored the cancel and offers retry', () => {
    expect(boxCancelLines([drawing])).toEqual([{
      id: 2,
      text: 'The GPU box is still drawing a cancelled job (Warrior:2, cell 176/205) — it ignored the cancel',
      retry: true,
    }]);
  });
  it('a null last_progress falls back to no progress reported', () => {
    expect(boxCancelLines([{ ...stopping, last_progress: null }])[0].text).toBe('Stopping on the GPU box… (no progress reported)');
    expect(boxCancelLines([{ ...drawing, last_progress: null }])[0].text).toContain('(Warrior:2, no progress reported)');
  });
  it('a null subject falls back to unknown subject in both strings', () => {
    expect(boxCancelLines([{ ...drawing, subject: null }])[0].text).toContain('(unknown subject, cell 176/205)');
    expect(startBatchWarning([{ ...drawing, subject: null }])).toBe('The GPU box is still busy with a cancelled job (unknown subject); new work waits behind it.');
  });
  it('a failed send says the cancel did not reach the box and offers retry, whatever the state', () => {
    for (const row of [stopping, drawing]) {
      expect(boxCancelLines([{ ...row, send_error: 'GPU box answered 500' }])).toEqual([{
        id: row.id,
        text: `The cancel did not reach the GPU box (${row.subject}): GPU box answered 500`,
        retry: true,
      }]);
    }
  });
  it('tolerates a missing array', () => {
    expect(boxCancelLines(undefined)).toEqual([]);
  });
  it('startBatchWarning is the verbatim text for the first open row, else null', () => {
    expect(startBatchWarning([drawing, stopping])).toBe('The GPU box is still busy with a cancelled job (Warrior:2); new work waits behind it.');
    expect(startBatchWarning([])).toBeNull();
    expect(startBatchWarning(undefined)).toBeNull();
  });
});

describe('force regenerate helpers (SOMET-698)', () => {
  it('forceConfirmText names the count and the approved-art promise', () => {
    expect(forceConfirmText(3)).toBe('Force regenerate 3 subject(s)? Their kept concept and any unapproved sheets are deleted and drawn again from scratch. Approved art stays until you approve the new sheet.');
  });

  it('refusedLines names the subject, for entities and for appearance variants', () => {
    const rows = [
      { id: 4, name: 'Wolf', variant: null },
      { id: 'a', entity_id: 3, variant: 2, name: 'Mage 2' },
      { id: 9, name: 'Other', variant: null },
    ];
    const refused = [
      { entity_id: 4, variant: null, reason: 'concept is still being drawn, try again in a minute' },
      { entity_id: 3, variant: 2, reason: 'busy' },
    ];
    expect(refusedLines(refused, rows)).toEqual([
      'Wolf: concept is still being drawn, try again in a minute',
      'Mage 2: busy',
    ]);
  });

  it('refusedLines falls back to the id and tolerates no refusals', () => {
    expect(refusedLines([{ entity_id: 8, variant: null, reason: 'x' }], [])).toEqual(['8: x']);
    expect(refusedLines(undefined, [])).toEqual([]);
  });
});

describe('new creature form helpers (SOMET-699)', () => {
  // Spelled out rather than read from the constant: this is what AC2 asks for,
  // and what the Entities tab's Add New Entity modal shows.
  const ENTITIES_TAB_DEFAULTS = {
    walkable: false, spawn_tiles: [], chance: 0.1, render_mode: 'rect', idle_fx: 'none',
    strength: 10, dexterity: 10, constitution: 10, intelligence: 10, wisdom: 10, charisma: 10,
    hp: 100, max_hp: 100, hp_regen_rate: 1, mana: 50, max_mana: 50, mana_regen_rate: 0.5,
    display_width: 64, display_height: 64, place_order: 0, attack_element: 'physical',
  };
  it('newCreatureBody trims the name, omits a blank prompt and maps the shape', () => {
    expect(newCreatureBody({ name: '  Wolf ', prompt: '   ', shape: 'creature' })).toEqual({
      ...ENTITIES_TAB_DEFAULTS, name: 'Wolf', color: '#808080', is_creature: true,
    });
    expect(newCreatureBody({ name: 'Barrel', prompt: ' a barrel ', shape: 'prop' })).toEqual({
      ...ENTITIES_TAB_DEFAULTS, name: 'Barrel', prompt: 'a barrel', color: '#808080', is_creature: false,
    });
  });
  it('the Entities tab new form builds from the same defaults', () => {
    expect(NEW_ENTITY_DEFAULTS).toEqual(ENTITIES_TAB_DEFAULTS);
    const source = readFileSync(new URL('../EntityTypesAdmin.jsx', import.meta.url), 'utf8');
    const newBranch = source.slice(source.indexOf('} else {\n      setFormData({'));
    expect(newBranch.slice(0, 400)).toContain('...NEW_ENTITY_DEFAULTS');
    expect(newBranch.slice(0, 400)).not.toMatch(/\bhp: 100\b/);
  });
  it('newCreatureError blocks empty and whitespace-only names', () => {
    expect(newCreatureError('')).toBe('Name is required');
    expect(newCreatureError('   ')).toBe('Name is required');
    expect(newCreatureError(undefined)).toBe('Name is required');
    expect(newCreatureError('Wolf')).toBeNull();
  });
});

describe('sprite table sort', () => {
  const ids = (list) => list.map((row) => row.id);
  const by = (column, dir) => ({ column, dir });

  describe('last update', () => {
    const at = (id, job_updated_at) => ({ id, job_updated_at });
    const rows = [
      at('never'),
      at('old', '2026-10-01T00:00:00.000Z'),
      at('null', null),
      at('new', '2026-11-01T00:00:00.000Z'),
      at('mid', '2026-10-15T00:00:00.000Z'),
      at('bad', 'not a date'),
    ];
    it('newest first, rows with no usable time last in their original order', () => {
      expect(ids(sortSpriteSubjects(rows, by('updated', 'desc')))).toEqual(['new', 'mid', 'old', 'never', 'null', 'bad']);
    });
    it('oldest first still keeps rows with no usable time last', () => {
      expect(ids(sortSpriteSubjects(rows, by('updated', 'asc')))).toEqual(['old', 'mid', 'new', 'never', 'null', 'bad']);
    });
    it('compares instants, not text: a later time in another offset sorts as later', () => {
      const offset = [at('a', '2026-10-01T23:00:00.000Z'), at('b', '2026-10-02T01:00:00.000+05:00')];
      expect(ids(sortSpriteSubjects(offset, by('updated', 'desc')))).toEqual(['a', 'b']);
    });
    it('rows with the same time keep their original order', () => {
      const same = [at('x', '2026-10-01T00:00:00.000Z'), at('y', '2026-10-01T00:00:00.000Z')];
      expect(ids(sortSpriteSubjects(same, by('updated', 'desc')))).toEqual(['x', 'y']);
      expect(ids(sortSpriteSubjects(same, by('updated', 'asc')))).toEqual(['x', 'y']);
    });
    it('no sort returns the rows in their given order', () => {
      expect(ids(sortSpriteSubjects(rows, null))).toEqual(ids(rows));
    });
    it('does not reorder the array it was given', () => {
      const before = ids(rows);
      sortSpriteSubjects(rows, by('updated', 'desc'));
      expect(ids(rows)).toEqual(before);
    });
  });

  it('shape sorts by the shape the row displays', () => {
    const rows = [{ id: 'p', is_creature: false }, { id: 'c', is_creature: true }, { id: 'hero', is_playable: true }];
    expect(ids(sortSpriteSubjects(rows, by('shape', 'asc')))).toEqual(['c', 'hero', 'p']);
    expect(ids(sortSpriteSubjects(rows, by('shape', 'desc')))).toEqual(['p', 'c', 'hero']);
  });

  it('actions sorts by the displayed text, a box prop by its effect, empty rows last both ways', () => {
    const rows = [
      { id: 'none' },
      { id: 'walk', actions: ['walk'] },
      { id: 'prop', backend: 'gpu-box', generation_kind: 'object', prop_fx: 'drift', actions: ['walk'] },
      { id: 'attack', actions: ['attack', 'idle'] },
    ];
    expect(ids(sortSpriteSubjects(rows, by('actions', 'asc')))).toEqual(['attack', 'prop', 'walk', 'none']);
    expect(ids(sortSpriteSubjects(rows, by('actions', 'desc')))).toEqual(['walk', 'prop', 'attack', 'none']);
  });

  it('directions sorts by how many, then which, empty rows last both ways', () => {
    const rows = [
      { id: 'none', directions: [] },
      { id: 'eight', directions: ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'] },
      { id: 'sen', directions: ['s', 'e', 'n'] },
      { id: 'se', directions: ['s', 'e'] },
      { id: 'sew', directions: ['s', 'e', 'w'] },
      { id: 'sen2', directions: ['s', 'e', 'n'] },
    ];
    expect(ids(sortSpriteSubjects(rows, by('directions', 'asc')))).toEqual(['se', 'sen', 'sen2', 'sew', 'eight', 'none']);
    expect(ids(sortSpriteSubjects(rows, by('directions', 'desc')))).toEqual(['eight', 'sew', 'sen', 'sen2', 'se', 'none']);
  });

  it('backend sorts by the full displayed label', () => {
    const rows = [{ id: 'l' }, { id: 'g3', backend: 'gpu-box', sheet_method: 'turnaround3d' }, { id: 'g', backend: 'gpu-box' }];
    expect(ids(sortSpriteSubjects(rows, by('backend', 'asc')))).toEqual(['g', 'g3', 'l']);
  });

  it('status sorts in workflow order, not alphabetically; never-queued rows last both ways', () => {
    const rows = ['approved', 'done', undefined, 'failed', 'queued', 'running'].map((job_state) => ({ id: job_state ?? 'none', job_state }));
    expect(ids(sortSpriteSubjects(rows, by('status', 'asc')))).toEqual(['running', 'queued', 'failed', 'done', 'approved', 'none']);
    expect(ids(sortSpriteSubjects(rows, by('status', 'desc')))).toEqual(['approved', 'done', 'failed', 'queued', 'running', 'none']);
  });

  it('a text column starts A-Z, Last update starts newest; the third click clears', () => {
    expect(nextSpriteSort(null, 'status')).toEqual(by('status', 'asc'));
    expect(nextSpriteSort(by('status', 'asc'), 'status')).toEqual(by('status', 'desc'));
    expect(nextSpriteSort(by('status', 'desc'), 'status')).toBe(null);
    expect(nextSpriteSort(null, 'updated')).toEqual(by('updated', 'desc'));
    expect(nextSpriteSort(by('updated', 'desc'), 'updated')).toEqual(by('updated', 'asc'));
    expect(nextSpriteSort(by('updated', 'asc'), 'updated')).toBe(null);
  });

  it('clicking another column starts that column fresh', () => {
    expect(nextSpriteSort(by('status', 'desc'), 'shape')).toEqual(by('shape', 'asc'));
    expect(nextSpriteSort(by('shape', 'asc'), 'updated')).toEqual(by('updated', 'desc'));
  });
});

describe('sprite table column filters', () => {
  const ids = (list) => list.map((row) => row.id);
  const opts = (over) => ({ shape: 'all', status: 'all', search: '', ...over });

  it('actions match any row that has the action; None means rows with no actions', () => {
    const rows = [{ id: 'both', name: 'a', actions: ['idle', 'walk'] }, { id: 'idle', name: 'b', actions: ['idle'] }, { id: 'none', name: 'c' }, { id: 'empty', name: 'd', actions: [] }];
    expect(ids(filterSpriteSubjects(rows, opts({ actions: 'walk' })))).toEqual(['both']);
    expect(ids(filterSpriteSubjects(rows, opts({ actions: 'idle' })))).toEqual(['both', 'idle']);
    expect(ids(filterSpriteSubjects(rows, opts({ actions: 'none' })))).toEqual(['none', 'empty']);
  });

  it('a box prop filters by the effect it displays, not its hidden queued actions', () => {
    const prop = { id: 'p', name: 'Rock', backend: 'gpu-box', generation_kind: 'object', prop_fx: 'drift', actions: ['walk'] };
    expect(actionTokens(prop)).toEqual(['effect: Drift']);
    expect(filterSpriteSubjects([prop], opts({ actions: 'walk' }))).toEqual([]);
    expect(ids(filterSpriteSubjects([prop], opts({ actions: 'effect: Drift' })))).toEqual(['p']);
  });

  it('directions match any row drawn in that facing', () => {
    const rows = [{ id: 'se', name: 'a', directions: ['s', 'e'] }, { id: 'n', name: 'b', directions: ['n'] }, { id: 'none', name: 'c' }];
    expect(ids(filterSpriteSubjects(rows, opts({ directions: 'e' })))).toEqual(['se']);
    expect(ids(filterSpriteSubjects(rows, opts({ directions: 'none' })))).toEqual(['none']);
  });

  it('backend matches each part of the displayed label, so gpu-box includes gpu-box · 3D', () => {
    const rows = [{ id: 'g', name: 'a', backend: 'gpu-box' }, { id: 'g3', name: 'b', backend: 'gpu-box', sheet_method: 'turnaround3d' }, { id: 'l', name: 'c' }];
    expect(backendTokens(rows[1])).toEqual(['gpu-box', '3D']);
    expect(ids(filterSpriteSubjects(rows, opts({ backend: 'gpu-box' })))).toEqual(['g', 'g3']);
    expect(ids(filterSpriteSubjects(rows, opts({ backend: '3D' })))).toEqual(['g3']);
    expect(ids(filterSpriteSubjects(rows, opts({ backend: 'local' })))).toEqual(['l']);
  });

  it('status none finds rows that were never queued', () => {
    const rows = [{ id: 'q', name: 'a', job_state: 'queued' }, { id: 'none', name: 'b' }];
    expect(ids(filterSpriteSubjects(rows, opts({ status: 'none' })))).toEqual(['none']);
  });

  it('last update windows count back from now; never means no usable time', () => {
    const now = Date.parse('2026-11-04T12:00:00.000Z');
    const ago = (hours) => new Date(now - hours * 3600 * 1000).toISOString();
    const rows = [
      { id: '30m', name: 'a', job_updated_at: ago(0.5) },
      { id: '2h', name: 'b', job_updated_at: ago(2) },
      { id: '2d', name: 'c', job_updated_at: ago(48) },
      { id: '10d', name: 'd', job_updated_at: ago(240) },
      { id: '60d', name: 'e', job_updated_at: ago(1440) },
      { id: 'never', name: 'f' },
    ];
    const run = (updated) => ids(filterSpriteSubjects(rows, opts({ updated, now })));
    expect(run('hour')).toEqual(['30m']);
    expect(run('day')).toEqual(['30m', '2h']);
    expect(run('week')).toEqual(['30m', '2h', '2d']);
    expect(run('month')).toEqual(['30m', '2h', '2d', '10d']);
    expect(run('older')).toEqual(['60d']);
    expect(run('never')).toEqual(['never']);
    expect(run('all')).toHaveLength(6);
  });

  it('every filter defaults to no filtering, and they combine', () => {
    const rows = [
      { id: 'hit', name: 'a', actions: ['idle'], directions: ['s'], backend: 'gpu-box' },
      { id: 'miss', name: 'b', actions: ['idle'], directions: ['n'], backend: 'gpu-box' },
    ];
    expect(ids(filterSpriteSubjects(rows, opts({})))).toEqual(['hit', 'miss']);
    expect(ids(filterSpriteSubjects(rows, opts({ actions: 'idle', directions: 's', backend: 'gpu-box' })))).toEqual(['hit']);
  });

  it('choices come from the rows, sorted and unique', () => {
    const rows = [{ actions: ['walk', 'idle'] }, { actions: ['idle'] }, {}];
    expect(columnFilterChoices(rows, actionTokens, 'all')).toEqual(['idle', 'walk']);
  });

  it('the selected choice stays listed after the rows carrying it refresh away', () => {
    expect(columnFilterChoices([{ actions: ['idle'] }], actionTokens, 'walk')).toEqual(['idle', 'walk']);
    expect(columnFilterChoices([{ actions: ['idle'] }], actionTokens, 'none')).toEqual(['idle']);
  });

  it('direction choices follow compass order, not the alphabet', () => {
    const rows = [{ directions: ['w', 'n', 's', 'e'] }];
    expect(directionTokens(rows[0])).toEqual(['w', 'n', 's', 'e']);
    expect(columnFilterChoices(rows, directionTokens, 'all', SPRITE_DIRECTIONS)).toEqual(['s', 'e', 'n', 'w']);
  });
});

// SOMET-721: a row 'running' with no run behind it was reported as "Batch idle".
describe('batchHeadline', () => {
  it('a live run is running, whatever the counts say', () => {
    expect(batchHeadline({ run: { running: true }, stats: { running: 1 } })).toEqual({ title: 'Batch running', hint: '' });
  });

  it('a running row with no live run is interrupted and says how to recover', () => {
    for (const run of [null, { running: false }]) {
      const { title, hint } = batchHeadline({ run, stats: { queued: 5, running: 1 } });
      expect(title).toBe('Batch interrupted');
      expect(hint).toMatch(/Rescue stranded/);
      expect(hint).toMatch(/Start batch/);
      // Start batch with the box down fails every queued row.
      expect(hint).toMatch(/GPU box is reachable/);
      // Rescue skips a row claimed in the last minute, with no message.
      expect(hint).toMatch(/last minute/);
    }
  });

  it('a run that ended because the box was unreachable says why (SOMET-756)', () => {
    const run = { running: false, endedReason: 'the GPU box could not be reached (x)' };
    expect(batchHeadline({ run, stats: { queued: 4 } })).toEqual({ title: 'Batch ended: box unreachable', hint: run.endedReason });
    expect(batchHeadline({ run: { running: true, endedReason: null }, stats: {} }).title).toBe('Batch running');
  });

  it('queued rows alone are idle: nothing was interrupted', () => {
    expect(batchHeadline({ run: null, stats: { queued: 5 } })).toEqual({ title: 'Batch idle', hint: '' });
    expect(batchHeadline({})).toEqual({ title: 'Batch idle', hint: '' });
  });
});

// SOMET-709: the form's default s/e/n on an 8-way sheet makes a smaller sheet.
describe('directionLossLines', () => {
  const eight = ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'];
  const creature = (name, over = {}) => ({ name, is_creature: true, render_mode: 'sprite', generation_kind: 'creature', sheet_directions: eight, ...over });

  it('names the row and the directions the new sheet will not have, in compass order', () => {
    expect(directionLossLines([creature('Warrior — Appearance 2')], ['s', 'e', 'n'])).toEqual([
      'Warrior — Appearance 2: the new sheet will not have se, ne, nw, w, sw (the current sheet does). Tick to include.',
    ]);
  });
  it('says nothing when the run has every direction of the current sheet, or more', () => {
    expect(directionLossLines([creature('A')], eight)).toEqual([]);
    expect(directionLossLines([creature('A', { sheet_directions: ['s', 'e'] })], ['s', 'e', 'n'])).toEqual([]);
  });
  it('says nothing for a row with no sheet yet', () => {
    expect(directionLossLines([creature('A', { sheet_directions: null })], ['s'])).toEqual([]);
    expect(directionLossLines([creature('A', { sheet_directions: undefined })], ['s'])).toEqual([]);
  });
  it('skips a prop, which has no directions, and a running row, which keeps its options', () => {
    const prop = { name: 'Tree', render_mode: 'static', is_creature: false, generation_kind: 'object', sheet_directions: eight };
    expect(spriteShape(prop)).toBe('flat');
    expect(directionLossLines([prop], ['s'])).toEqual([]);
    expect(directionLossLines([creature('A', { job_state: 'running' })], ['s'])).toEqual([]);
  });
  it('says nothing with no direction ticked: Queue is blocked for that already', () => {
    expect(directionLossLines([creature('A')], [])).toEqual([]);
  });
  it('groups rows that lose the same directions, and shortens a long list of names', () => {
    const lines = directionLossLines([
      creature('A'), creature('B'), creature('C'), creature('D'), creature('E'),
      creature('F', { sheet_directions: ['s', 'w'] }),
    ], ['s', 'e', 'n']);
    expect(lines).toEqual([
      'A, B, C and 2 more: the new sheet will not have se, ne, nw, w, sw (the current sheet does). Tick to include.',
      'F: the new sheet will not have w (the current sheet does). Tick to include.',
    ]);
  });
});

describe('methodOptionLabel / tookLabel', () => {
  const method = { id: 'fits_fast', label: 'Fits card, fast', eta_seconds_per_cell: 23.5 };
  const model = {
    fixedSeconds: 270, perCellOverhead: 0, roundSeconds: 40,
    r: { low: 0, typical: 0.3, high: 1.45 }, rounds: { low: 0, typical: 1, high: 3 },
  };
  const ALL = ['idle', 'walk', 'attack', 'cast', 'damage', 'death', 'use'];
  const humanoid = { id: 'a', is_creature: true };
  const wolf = { id: 'b', is_creature: true, body_plan: 'quadruped' };
  const sel = (rows) => ({ rows, actions: ALL, directions: ['s', 'e', 'n'], frames: 4 });

  it('method label for one default humanoid is "Fits card, fast — ~39 min"', () => {
    expect(methodOptionLabel(method, sel([humanoid]), model, false)).toBe('Fits card, fast — ~39 min');
  });
  it('method label for one humanoid + one quadruped sums per-row cells (quadruped 5 actions)', () => {
    // c=23.5: quadruped 60 cells + 3 facings -> 270+23.5*63 = 1750.5 s; humanoid 2314.5 s; total 4065 s
    expect(methodOptionLabel(method, sel([humanoid, wolf]), model, false)).toBe('Fits card, fast — ~1 h 8 min');
  });
  it('QA on shows a range', () => {
    expect(methodOptionLabel(method, sel([humanoid]), model, true)).toBe('Fits card, fast — ~39 min – ~1 h 28 min');
  });
  it('shows no time when no creature row is selected', () => {
    expect(methodOptionLabel(method, sel([]), model, false)).toBe('Fits card, fast');
    expect(methodOptionLabel(method, sel([{ id: 'p', is_creature: false }]), model, false)).toBe('Fits card, fast');
  });
  it('a secondsPerCell override (HQ connector) beats the method rate', () => {
    // c=40: 270+40*87 = 3750 s
    expect(methodOptionLabel(method, { ...sel([humanoid]), secondsPerCell: 40 }, model, false)).toBe('Fits card, fast — ~1 h 3 min');
  });
  it('on HQ a preset method uses its own hq rate; the box default uses the connector rate', () => {
    const hqSel = { ...sel([humanoid]), secondsPerCell: 40, engine: 'comfyui-hq' };
    const guided = { id: 'guided', label: 'Guided', sampling: 'guided', eta_seconds_per_cell: 175, hq_seconds_per_cell: 80 };
    // c=80: 270+80*87 = 7230 s; QA off
    expect(methodOptionLabel(guided, hqSel, model, false)).toBe('Guided — ~2 h 1 min');
    // sampling null: the connector's 40 s/cell (3750 s), not the method rate
    expect(methodOptionLabel(method, hqSel, model, false)).toBe('Fits card, fast — ~1 h 3 min');
    // not HQ: the engine key is absent and hq_seconds_per_cell is ignored
    expect(methodOptionLabel(guided, sel([humanoid]), model, false)).toBe('Guided — ~4 h 18 min');
  });
  it('falls back to the connector then catalog rate when the method has none', () => {
    const bare = { id: 'x', label: 'Bare' };
    expect(methodOptionLabel(bare, sel([humanoid]), model, false)).toBe('Bare');
    expect(methodOptionLabel(bare, { ...sel([humanoid]), fallbackSecondsPerCell: 23.5 }, model, false)).toBe('Bare — ~39 min');
  });
  it('selectionCells agrees with the ETA cell count (quadruped drop, mirrored west)', () => {
    expect(selectionCells({ ...sel([humanoid, wolf]), directions: ['s', 'e', 'w'] })).toBe(7 * 2 * 4 + 5 * 2 * 4);
    expect(selectionCells(sel([humanoid, wolf]))).toBe(84 + 60);
  });
  it('tookLabel formats took/est and omits est when missing', () => {
    expect(tookLabel({ sheet_seconds: 3120, predicted_seconds: 2950 })).toBe('took 52 min (est. 49 min)');
    expect(tookLabel({ sheet_seconds: 3120, predicted_seconds: null })).toBe('took 52 min');
    expect(tookLabel({ sheet_seconds: null, predicted_seconds: 2950 })).toBeNull();
    expect(tookLabel({})).toBeNull();
  });
});

describe('QA toggle (source gate, the suite has no DOM)', () => {
  const src = readFileSync(path.resolve(__dirname, '../SpriteConsoleAdmin.jsx'), 'utf8');
  it('renders the Auto-fix checkbox, unchecked by default, and sends it in the payload', () => {
    expect(src).toContain('Auto-fix bad frames (slower, time varies)');
    expect(src).toMatch(/const \[qualityChecks, setQualityChecks\] = useState\(false\)/);
    expect(src).toMatch(/qualityChecks: isHq \? null : qualityChecks/);
  });
  it('queuePayload carries quality_checks false/true, and omits it when null (HQ)', () => {
    const cat = { actions: [{ id: 'idle' }] };
    const row = { id: 1, is_creature: true };
    expect(queuePayload(cat, [row], { actions: ['idle'], frames: 4, qualityChecks: false }).quality_checks).toBe(false);
    expect(queuePayload(cat, [row], { actions: ['idle'], frames: 4, qualityChecks: true }).quality_checks).toBe(true);
    expect('quality_checks' in queuePayload(cat, [row], { actions: ['idle'], frames: 4, qualityChecks: null })).toBe(false);
  });
});

describe('waitLabel', () => {
  it('formats the wait and the model switch', () => {
    expect(waitLabel({ ahead_seconds: 4200, switch_seconds_max: 0 })).toBe('~1 h 10 min waiting on the box');
    expect(waitLabel({ ahead_seconds: 4200, switch_seconds_max: 300 })).toBe('~1 h 10 min waiting on the box · + up to 5 min model switch');
    expect(waitLabel({ ahead_seconds: 0, switch_seconds_max: 0 })).toBe('< 1 min waiting on the box');
  });
  it('is "box queue unknown" when the wait is unknown or the answer is missing', () => {
    expect(waitLabel({ ahead_seconds: null, switch_seconds_max: 300 })).toBe('box queue unknown');
    expect(waitLabel(null)).toBe('box queue unknown');
  });
});
