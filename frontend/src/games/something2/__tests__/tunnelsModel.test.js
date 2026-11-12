import { describe, it, expect } from 'vitest';
import { formatUptime, statusLabel, endReasonLabel, canToggle, cardAction, canEditMode, modeSuffix, isStillWorking } from '../tunnelsModel.js';

const T0 = Date.parse('2026-11-12T10:00:00Z');

describe('formatUptime', () => {
  it('shows minutes under an hour', () => {
    expect(formatUptime(new Date(T0).toISOString(), T0 + 59_000)).toBe('On for 0 min');
    expect(formatUptime(new Date(T0).toISOString(), T0 + 5 * 60_000)).toBe('On for 5 min');
  });
  it('shows hours and minutes', () => {
    expect(formatUptime(new Date(T0).toISOString(), T0 + 84 * 60_000)).toBe('On for 1 h 24 min');
  });
  it('is blank without a usable start and never negative', () => {
    expect(formatUptime(null, T0)).toBe('');
    expect(formatUptime('garbage', T0)).toBe('');
    expect(formatUptime(new Date(T0).toISOString(), T0 - 5000)).toBe('On for 0 min');
  });
});

describe('labels', () => {
  it('statusLabel', () => {
    expect(statusLabel('off')).toBe('Off');
    expect(statusLabel('starting')).toBe('Starting…');
    expect(statusLabel('on')).toBe('On');
    expect(statusLabel('failed')).toBe('Failed');
    expect(statusLabel('busy')).toBe('ngrok is busy with another project');
    expect(statusLabel('weird')).toBe('Off');
  });
  it('endReasonLabel', () => {
    expect(endReasonLabel('switched_off')).toBe('You switched it off');
    expect(endReasonLabel('went_down')).toBe('Laptop or containers went down');
    expect(endReasonLabel('crashed')).toBe('Crashed');
    expect(endReasonLabel('failed_to_start')).toBe('Failed to start');
    expect(endReasonLabel(null)).toBe('Still running');
    expect(endReasonLabel('x')).toBe('x');
  });
});

describe('canToggle', () => {
  it('is false while pending or starting', () => {
    expect(canToggle({ state: 'off' }, true)).toBe(false);
    expect(canToggle({ state: 'starting' }, false)).toBe(false);
  });
  it('is true for off, on, failed, busy otherwise', () => {
    for (const state of ['off', 'on', 'failed', 'busy']) expect(canToggle({ state }, false)).toBe(true);
    expect(canToggle(null, false)).toBe(false);
  });
});

describe('cardAction / canEditMode', () => {
  it('maps all five states', () => {
    expect(cardAction('off')).toBe('start');
    expect(cardAction('failed')).toBe('start');
    expect(cardAction('busy')).toBe('start');
    expect(cardAction('on')).toBe('stop');
    expect(cardAction('starting')).toBe('wait');
  });
  it('edits the mode only when idle', () => {
    for (const st of ['off', 'failed', 'busy']) expect(canEditMode(st, false)).toBe(true);
    for (const st of ['on', 'starting']) expect(canEditMode(st, false)).toBe(false);
    expect(canEditMode('off', true)).toBe(false);
  });
});

describe('modeSuffix (History)', () => {
  it('shows the mode in brackets, nothing when it is unknown', () => {
    expect(modeSuffix('built')).toBe(' (built)');
    expect(modeSuffix('live')).toBe(' (live)');
    expect(modeSuffix(null)).toBe('');
    expect(modeSuffix(undefined)).toBe('');
  });
});

describe('isStillWorking', () => {
  it('is true only for the 504 helper_timeout answer', () => {
    expect(isStillWorking({ status: 504 })).toBe(true);
    expect(isStillWorking({ status: 503 })).toBe(false);
    expect(isStillWorking(null)).toBe(false);
  });
});
