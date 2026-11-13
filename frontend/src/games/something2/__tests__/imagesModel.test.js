import { describe, it, expect } from 'vitest';
import { estimateWebBytes, formatBytes, ratioFor, subjectId, pagesOf, canUndo, canShrink, runBody, buildParams, runFinished, overrideByKind, opLabel, autoShrinkOn } from '../imagesModel.js';

describe('formatBytes', () => {
  it('formats KB and MB', () => {
    expect(formatBytes(455000)).toBe('455 KB');
    expect(formatBytes(31_200_000)).toBe('31.2 MB');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(null)).toBe('—');
  });
});

describe('estimateWebBytes', () => {
  it('uses the spike ratio per kind', () => {
    expect(Math.abs(estimateWebBytes([{ kind: 'entity', bytes: 455000 }], {}) - 24000)).toBeLessThan(1000);
    expect(estimateWebBytes([{ kind: 'item', bytes: 1000 }], {})).toBeCloseTo(100);
    expect(estimateWebBytes([{ kind: 'effect:vfx_effects', bytes: 1000 }], {})).toBeCloseTo(440);
    expect(estimateWebBytes([{ kind: 'entity_sheet', bytes: 1000 }], {})).toBeCloseTo(440);
  });
  it('sums rows and tolerates junk', () => {
    expect(estimateWebBytes([], {})).toBe(0);
    expect(estimateWebBytes([{ kind: 'tile', bytes: 1000 }, { kind: 'appearance', bytes: 1000 }, { kind: 'tile' }], {})).toBeCloseTo(123);
  });
  it('an explicit smaller edge shrinks the estimate by area', () => {
    const rows = [{ kind: 'entity', bytes: 100000 }];
    const base = estimateWebBytes(rows, {});
    expect(estimateWebBytes(rows, { entity: { maxEdge: 128 } })).toBeLessThan(base);
  });
});

describe('helpers', () => {
  it('ratioFor falls back for unknown kinds', () => {
    expect(ratioFor('weird')).toBe(0.1);
    expect(ratioFor('art:item')).toBe(0.1);
  });
  it('subjectId is stable per table/key/column', () => {
    expect(subjectId({ subject: { table: 't', key: 'k', column: 'c' } })).toBe('t\u0000k\u0000c');
  });
  it('pagesOf slices', () => {
    expect(pagesOf([1, 2, 3, 4, 5], 2, 1)).toEqual([3, 4]);
    expect(pagesOf([1, 2, 3], 2, 5)).toEqual([]);
  });
  it('runBody omits params unless overridden', () => {
    const rows = [{ subject: { table: 't', key: 'k', column: 'c' }, kind: 'x', extra: 1 }];
    expect(runBody('shrink', rows, undefined)).toEqual({ op: 'shrink', subjects: [{ table: 't', key: 'k', column: 'c' }] });
    expect('params' in runBody('shrink', rows, {})).toBe(false);
    expect(runBody('shrink', rows, { maxEdge: 128 }).params).toEqual({ maxEdge: 128 });
  });
  it('action availability by state', () => {
    expect(canShrink({ state: 'original' })).toBe(true);
    expect(canShrink({ state: 'stale' })).toBe(true);
    expect(canUndo({ state: 'shrunk' })).toBe(true);
    expect(canUndo({ state: 'original' })).toBe(false);
  });
});

describe('buildParams', () => {
  const img = { kind: 'entity' };
  const sheet = { kind: 'entity_sheet' };
  it('is empty when nothing was overridden', () => {
    expect(buildParams([img], {})).toEqual({ params: null });
    expect(buildParams([img], { maxEdge: '', scale: '', quality: '' })).toEqual({ params: null });
  });
  it('needs the applicable field for every kind selected', () => {
    expect(buildParams([img], { maxEdge: '128' })).toEqual({ params: { maxEdge: 128 } });
    expect(buildParams([img], { maxEdge: '128', quality: '70' })).toEqual({ params: { maxEdge: 128, quality: 70 } });
    expect(buildParams([sheet], { scale: '0.5' })).toEqual({ params: { scale: 0.5 } });
    expect(buildParams([img, sheet], { maxEdge: '128' }).error).toMatch(/scale/);
    expect(buildParams([img], { quality: '70' }).error).toMatch(/maxEdge/);
  });
  it('rejects out of range values', () => {
    expect(buildParams([img], { maxEdge: '0' }).error).toBeTruthy();
    expect(buildParams([sheet], { scale: '1.5' }).error).toBeTruthy();
    expect(buildParams([img], { maxEdge: '128', quality: '101' }).error).toBeTruthy();
  });
});

describe('auto-shrink helpers', () => {
  it('runFinished fires only on a running -> not-running transition (or a new finished run)', () => {
    const running = { id: 'r1', status: 'running' };
    const done = { id: 'r1', status: 'done' };
    expect(runFinished(running, done)).toBe(true);
    expect(runFinished(done, done)).toBe(false); // a refetch of a finished run
    expect(runFinished(undefined, done)).toBe(false); // first load: the list loads itself
    expect(runFinished(done, running)).toBe(false);
    expect(runFinished(done, { id: 'r2', status: 'done' })).toBe(true); // started and ended between polls
    expect(runFinished(null, { id: 'r2', status: 'done' })).toBe(true);
    expect(runFinished(done, null)).toBe(false);
  });
  it('overrideByKind applies the batch override to every selected kind', () => {
    const rows = [{ kind: 'entity' }, { kind: 'entity_sheet' }, { kind: 'entity' }];
    expect(overrideByKind(rows, null)).toEqual({});
    const p = { maxEdge: 128, scale: 0.5 };
    expect(overrideByKind(rows, p)).toEqual({ entity: p, entity_sheet: p });
  });
  it('the footer estimate follows the override', () => {
    const rows = [{ kind: 'entity', bytes: 100000 }];
    expect(estimateWebBytes(rows, overrideByKind(rows, { maxEdge: 128 }))).toBeLessThan(estimateWebBytes(rows, {}));
  });
  it('opLabel marks auto ops', () => {
    expect(opLabel({ op: 'shrink', params: { maxEdge: 256, auto: true } })).toBe('shrink · auto');
    expect(opLabel({ op: 'shrink', params: { maxEdge: 256 } })).toBe('shrink');
    expect(opLabel({ op: 'undo', params: null })).toBe('undo');
  });
  it('autoShrinkOn reads the setting row, default on', () => {
    expect(autoShrinkOn([])).toBe(true);
    expect(autoShrinkOn([{ key: 'image_auto_shrink', value: false }])).toBe(false);
    expect(autoShrinkOn([{ key: 'image_auto_shrink', value: true }])).toBe(true);
  });
});
