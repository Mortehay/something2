import { describe, expect, it } from 'vitest';
import {
  DIRECTION_ORDER, WESTERN, DOUBLED, frameKey, parseFrameKey, isMarkable, toggleMark, markRow,
  contextFrames, rowSummary, redrawPayload, qualityByFrame, changedUnmarked, shouldConfirmClose,
} from '../frameRedraw.js';

const manifest = {
  cell: [1, 1],
  frames_per_action: 2,
  rows: [
    { row: 0, action: 'walk', direction: 's', frames: 2 },
    { row: 1, action: 'walk', direction: 'se', frames: 2 },
    { row: 2, action: 'idle', direction: 's', frames: 2 },
  ],
  frames: {
    'walk/s/0': [0, 0, 1, 1], 'walk/s/1': [1, 0, 1, 1],
    'walk/se/0': [0, 1, 1, 1], 'walk/se/1': [1, 1, 1, 1],
    'idle/s/0': [0, 2, 1, 1], 'idle/s/1': [1, 2, 1, 1],
  },
  quality: [
    { action: 'walk', direction: 's', frame: 1, passed: false, attempts: 3 },
    { action: 'walk', direction: 'se', frame: 0, passed: true, attempts: 1 },
  ],
};

describe('constants and keys', () => {
  it('exposes direction groups', () => {
    expect(DIRECTION_ORDER).toEqual(['s', 'se', 'e', 'ne', 'n']);
    expect(WESTERN).toEqual(['w', 'nw', 'sw']);
    expect(DOUBLED).toEqual(['e', 'ne', 'se']);
  });
  it('round-trips frame keys', () => {
    expect(frameKey('walk', 'se', 3)).toBe('walk/se/3');
    expect(parseFrameKey('walk/se/3')).toEqual({ action: 'walk', direction: 'se', frame: 3 });
  });
  it('western rows are not markable', () => {
    expect(isMarkable('nw')).toBe(false);
    expect(isMarkable('w')).toBe(false);
    expect(isMarkable('sw')).toBe(false);
    expect(isMarkable('s')).toBe(true);
  });
});

describe('marks', () => {
  it('toggleMark returns a new set', () => {
    const a = new Set();
    const b = toggleMark(a, 'walk/s/0');
    expect(a.size).toBe(0);
    expect([...b]).toEqual(['walk/s/0']);
    expect(toggleMark(b, 'walk/s/0').size).toBe(0);
  });
  it('markRow adds and removes a whole row without mutating', () => {
    const a = new Set(['idle/s/0']);
    const on = markRow(a, 'walk', 's', 2, true);
    expect([...on].sort()).toEqual(['idle/s/0', 'walk/s/0', 'walk/s/1']);
    expect(a.size).toBe(1);
    expect([...markRow(on, 'walk', 's', 2, false)]).toEqual(['idle/s/0']);
  });
  it('shouldConfirmClose only with marks', () => {
    expect(shouldConfirmClose(new Set())).toBe(false);
    expect(shouldConfirmClose(new Set(['walk/s/0']))).toBe(true);
  });
});

describe('contextFrames', () => {
  it('lists unmarked neighbours sorted', () => {
    expect(contextFrames(6, [2, 3])).toEqual([1, 4]);
    expect(contextFrames(6, [0])).toEqual([1]);
    expect(contextFrames(6, [5])).toEqual([4]);
    expect(contextFrames(6, [4, 1])).toEqual([0, 2, 3, 5]);
    expect(contextFrames(6, [])).toEqual([]);
  });
});

describe('rowSummary', () => {
  it('contiguous run', () => {
    expect(rowSummary(6, [2, 3])).toEqual({ text: 'f2, f3 redrawn in order · context: f1, f4', tone: 'normal' });
  });
  it('row start / row end', () => {
    expect(rowSummary(6, [0]).text).toBe('f0 · context: f1 only (row start)');
    expect(rowSummary(6, [5]).text).toBe('f5 · context: f4 only (row end)');
  });
  it('single middle frame uses plain wording', () => {
    expect(rowSummary(6, [2]).text).toBe('f2 · context: f1, f3');
  });
  it('start frames with more context use the generic form', () => {
    expect(rowSummary(6, [0, 1]).text).toBe('f0, f1 redrawn in order · context: f2');
  });
  it('several runs', () => {
    expect(rowSummary(6, [1, 4]).text).toBe('f1, f4 redrawn in order · context: f0, f2, f3, f5');
  });
  it('whole row warns', () => {
    expect(rowSummary(6, [0, 1, 2, 3, 4, 5])).toEqual({
      text: 'whole row · no neighbour context, drawn fresh from the concept', tone: 'warning',
    });
  });
  it('nothing marked is null', () => {
    expect(rowSummary(6, [])).toBe(null);
  });
  it('unsorted input is sorted', () => {
    expect(rowSummary(6, [3, 2]).text).toBe('f2, f3 redrawn in order · context: f1, f4');
  });
});

describe('redrawPayload', () => {
  it('orders by manifest rows and drops unknown keys', () => {
    const marks = new Set(['idle/s/1', 'walk/se/0', 'walk/s/1', 'walk/s/0', 'gone/s/0', 'walk/s/9']);
    expect(redrawPayload(marks, manifest)).toEqual([
      { action: 'walk', direction: 's', frame: 0 },
      { action: 'walk', direction: 's', frame: 1 },
      { action: 'walk', direction: 'se', frame: 0 },
      { action: 'idle', direction: 's', frame: 1 },
    ]);
  });
});

describe('qualityByFrame', () => {
  it('keeps only failed entries', () => {
    const map = qualityByFrame(manifest);
    expect([...map.keys()]).toEqual(['walk/s/1']);
    expect(map.get('walk/s/1').attempts).toBe(3);
    expect(qualityByFrame({}).size).toBe(0);
  });
});

describe('changedUnmarked', () => {
  const m = { frames: { 'a/s/0': [0, 0, 1, 1], 'a/s/1': [1, 0, 1, 1] } };
  const px = (a, b) => ({ width: 2, data: new Uint8ClampedArray([...a, ...b]) });
  it('reports changed cells that were not redrawn', () => {
    const prev = px([1, 2, 3, 4], [5, 6, 7, 8]);
    const next = px([9, 2, 3, 4], [5, 6, 7, 9]);
    expect(changedUnmarked(prev, next, m, ['a/s/0'])).toEqual(['a/s/1']);
    expect(changedUnmarked(prev, next, m, [{ action: 'a', direction: 's', frame: 1 }])).toEqual(['a/s/0']);
    expect(changedUnmarked(prev, prev, m, [])).toEqual([]);
  });
});
