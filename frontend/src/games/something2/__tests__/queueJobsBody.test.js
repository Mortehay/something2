import { describe, expect, it } from 'vitest';
import { queueJobsBody } from '../useSpriteConsole.js';
import { queuePayload, DIRECTION_PRESETS, SPRITE_DIRECTIONS } from '../spriteSelection.js';

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
