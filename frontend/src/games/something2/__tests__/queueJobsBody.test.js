import { describe, expect, it } from 'vitest';
import { queueJobsBody } from '../useSpriteConsole.js';
import { queuePayload, DIRECTION_PRESETS, SPRITE_DIRECTIONS, backendLabel, chosenConnector, isImageConnector, artSubjectsByKind, availableConnectors, unavailableConnectorLines, imageModeStatus, samplingOptionLabel, presetSecondsPerCell } from '../spriteSelection.js';

const catalog = { actions: [{ id: 'idle', max_frames: 8 }] };
const creatureRow = { id: 1, name: 'Wolf', is_creature: true, render_mode: 'static', sprite: null, image: '' };
const propRow = { id: 2, name: 'Torch', is_creature: false, render_mode: 'animated', job_state: 'failed' };

describe('queueJobsBody (SOMET-686)', () => {
  it('passes the chosen directions through to the queue request', () => {
    const body = queueJobsBody(queuePayload(catalog, [creatureRow], {
      actions: ['idle'], frames: 2, directions: DIRECTION_PRESETS[8],
    }));
    expect(body.directions).toEqual([...SPRITE_DIRECTIONS]);
    expect(body.directions).toHaveLength(8);
  });

  it('omits the directions key entirely when none are chosen', () => {
    const json = JSON.stringify(queueJobsBody({ targets: [], actions: ['idle'], frames: 1 }));
    expect(json).not.toContain('directions');
    expect(json).not.toContain('null');
  });

  it('passes a props-only payload through with prop_fx and no directions', () => {
    const body = queueJobsBody(queuePayload(catalog, [propRow], {
      actions: ['idle'], frames: 2, propFx: 'shine', directions: DIRECTION_PRESETS[8],
    }));
    expect(body).toEqual({
      targets: [{ entity_id: 2, variant: undefined }],
      actions: ['idle'], frames: 1, prop_fx: 'shine',
    });
    expect(JSON.stringify(body)).not.toContain('directions');
  });

  it('passes the chosen cell through for both queue and force (SOMET-706)', () => {
    const body = queueJobsBody(queuePayload(catalog, [creatureRow], { actions: ['idle'], frames: 2, cell: '96x128' }));
    expect(body.cell).toBe('96x128');
    expect(queueJobsBody(queuePayload(catalog, [creatureRow], { actions: ['idle'], frames: 2, cell: '48x64' })).cell).toBe('48x64');
  });

  it('sends no cell for a props-only selection', () => {
    const body = queueJobsBody(queuePayload(catalog, [propRow], { actions: ['idle'], frames: 2, cell: '96x128' }));
    expect(JSON.stringify(body)).not.toContain('cell');
  });
});

describe('redraw selected actions (SOMET-711)', () => {
  it('sends redraw_actions: true only when ticked, for creatures', () => {
    const on = queueJobsBody(queuePayload(catalog, [creatureRow], { actions: ['idle'], frames: 2, redrawActions: true }));
    expect(on.redraw_actions).toBe(true);
    const off = queueJobsBody(queuePayload(catalog, [creatureRow], { actions: ['idle'], frames: 2, redrawActions: false }));
    expect(JSON.stringify(off)).not.toContain('redraw_actions');
  });

  it('never sends it for a props-only selection', () => {
    const body = queueJobsBody(queuePayload(catalog, [propRow], { actions: ['idle'], frames: 2, redrawActions: true }));
    expect(JSON.stringify(body)).not.toContain('redraw_actions');
  });
});

describe('connector choice (HQ lane, SOMET-712)', () => {
  it('sends provider_id for a creature selection when a connector is chosen', () => {
    const body = queueJobsBody(queuePayload(catalog, [creatureRow], { actions: ['idle'], frames: 2, providerId: 5 }));
    expect(body.provider_id).toBe(5);
  });
  it('omits provider_id when none is chosen or the selection is props only', () => {
    expect(JSON.stringify(queueJobsBody(queuePayload(catalog, [creatureRow], { actions: ['idle'], frames: 2 })))).not.toContain('provider_id');
    expect(JSON.stringify(queueJobsBody(queuePayload(catalog, [propRow], { actions: ['idle'], frames: 2, providerId: 5 })))).not.toContain('provider_id');
  });
});

describe('Sprite tab connector helpers (SOMET-712)', () => {
  it('labels HQ rows', () => {
    expect(backendLabel({ backend: 'gpu-box', provider_engine: 'comfyui-hq' })).toBe('gpu-box · HQ');
    expect(backendLabel({ backend: 'gpu-box', provider_engine: null })).toBe('gpu-box');
    expect(backendLabel({})).toBe('local');
  });
  it('picks the chosen connector, else the active one, else the first', () => {
    const list = [{ id: 8, is_active: true }, { id: 12, is_active: false }];
    expect(chosenConnector(list, 12).id).toBe(12);
    expect(chosenConnector(list, null).id).toBe(8);
    expect(chosenConnector(list, 99).id).toBe(8);
    expect(chosenConnector([], null)).toBe(null);
  });

  it('never defaults to an active image provider while a sprite connector exists', () => {
    const list = [
      { id: 9, modality: 'sprite', is_active: false },
      { id: 5, modality: 'image', is_active: true },
    ];
    expect(chosenConnector(list, null).id).toBe(9);
    expect(chosenConnector(list, 5).id).toBe(5);
    expect(chosenConnector([{ id: 5, modality: 'image', is_active: true }], null).id).toBe(5);
  });
});

describe('connector availability', () => {
  const list = [
    { id: 9, name: 'gpu-box-sprites', available: true },
    { id: 4, name: 'desktop gpu', available: false, unavailable_reason: 'service answered 401' },
    { id: 5, name: 'desktop gpu (objects)', available: true },
  ];

  it('offers only the connections that answered', () => {
    expect(availableConnectors(list).map((c) => c.id)).toEqual([9, 5]);
    expect(availableConnectors(null)).toEqual([]);
  });

  it('a choice that stopped answering falls back to an available connector', () => {
    expect(chosenConnector(availableConnectors(list), 4).id).toBe(9);
  });

  it('names what was left out and why', () => {
    expect(unavailableConnectorLines(list)).toEqual(['desktop gpu: service answered 401']);
    expect(unavailableConnectorLines([{ id: 1, name: 'a', available: false }])).toEqual(['a: unavailable']);
  });
});

describe('status filter under an image connector', () => {
  it('keeps the two filters that mean something and drops the sheet-job ones', () => {
    expect(imageModeStatus('missing')).toBe('missing');
    expect(imageModeStatus('all')).toBe('all');
    for (const sheetOnly of ['queued', 'running', 'done', 'failed', 'approved']) {
      expect(imageModeStatus(sheetOnly)).toBe('missing');
    }
  });
});

describe('image connectors on the Sprite tab', () => {
  it('tells an image provider from a sheet connector', () => {
    expect(isImageConnector({ id: 5, modality: 'image' })).toBe(true);
    expect(isImageConnector({ id: 9, modality: 'sprite' })).toBe(false);
    expect(isImageConnector(null)).toBe(false);
  });

  it('maps rows to the keys POST /api/art-jobs expects, per kind', () => {
    const grouped = artSubjectsByKind([
      { id: 1, name: 'Wolf', variant: null },
      { id: 2, name: 'Torch' },
      { id: '7:3', entity_id: 7, variant: 3, class_name: 'Warrior', name: 'Warrior — Appearance 3' },
    ]);
    expect([...grouped]).toEqual([
      ['entity', ['Wolf', 'Torch']],
      ['character_appearance', ['Warrior:3']],
    ]);
  });
});


describe('sampling presets', () => {
  const PRESETS = [
    { id: null, label: 'Fast (box default)', steps: 4, cfg: 1, quant: null, seconds_per_cell: null },
    { id: 'guided_sharp', label: 'Guided, sharper', steps: 6, cfg: 4, quant: 'q6_k', seconds_per_cell: 175 },
  ];

  it('sends the chosen preset for creatures, never for a props-only press, never null', () => {
    expect(queueJobsBody(queuePayload(catalog, [creatureRow], { actions: ['idle'], frames: 2, sampling: 'guided' })).sampling).toBe('guided');
    expect(JSON.stringify(queueJobsBody(queuePayload(catalog, [creatureRow], { actions: ['idle'], frames: 2, sampling: null })))).not.toContain('sampling');
    expect(JSON.stringify(queueJobsBody(queuePayload(catalog, [propRow], { actions: ['idle'], frames: 2, sampling: 'guided' })))).not.toContain('sampling');
  });

  it('labels each preset with its steps, cfg and the hours for this press', () => {
    // 210 cells: default at the connector's 30 s/cell = 1 h 45 min; the preset at its own 175 s/cell = 10 h 13 min.
    expect(samplingOptionLabel(PRESETS[0], 210, 30)).toBe('Fast (box default) — 4 steps, cfg 1 · ~1 h 45 min');
    expect(samplingOptionLabel(PRESETS[1], 210, 30)).toBe('Guided, sharper — 6 steps, cfg 4, Q6_K · ~10 h 13 min');
    // nothing selected: no time (a '< 1 min' there read as a real estimate)
    expect(samplingOptionLabel(PRESETS[1], 0, 30)).toBe('Guided, sharper — 6 steps, cfg 4, Q6_K');
    expect(presetSecondsPerCell(PRESETS[1], 40)).toBe(175);
    expect(presetSecondsPerCell(PRESETS[0], 40)).toBe(40);
    expect(presetSecondsPerCell({ ...PRESETS[1], hq_seconds_per_cell: 235 }, 40, 'comfyui-hq')).toBe(235);
    expect(presetSecondsPerCell({ ...PRESETS[0], hq_seconds_per_cell: 40 }, 70, 'comfyui-hq')).toBe(40);
    expect(presetSecondsPerCell(undefined, 30)).toBe(30);
  });

  it('marks a row drawn at a preset in the Backend column', () => {
    expect(backendLabel({ backend: 'gpu-box', sampling: 'guided' })).toBe('gpu-box · guided');
    expect(backendLabel({ backend: 'gpu-box', provider_engine: 'comfyui-hq', sampling: 'sharp' })).toBe('gpu-box · HQ · sharp');
  });
});
